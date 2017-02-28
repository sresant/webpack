/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var path = require("path");
var RequestShortener = require("./RequestShortener");
var ConcatSource = require("webpack-sources").ConcatSource;
var RawSource = require("webpack-sources").RawSource;
var ModuleFilenameHelpers = require("./ModuleFilenameHelpers");
var SourceMapDevToolModuleOptionsPlugin = require("./SourceMapDevToolModuleOptionsPlugin");

function SourceMapDevToolPlugin(options) {
	if(arguments.length > 1)
		throw new Error("SourceMapDevToolPlugin only takes one argument (pass an options object)");
	if(typeof options === "string") {
		options = {
			sourceMapFilename: options
		};
	}
	if(!options) options = {};
	this.sourceMapFilename = options.filename;
	this.sourceMappingURLComment = options.append === false ? false : options.append || "\n//# sourceMappingURL=[url]";
	this.moduleFilenameTemplate = options.moduleFilenameTemplate || "webpack:///[resourcePath]";
	this.fallbackModuleFilenameTemplate = options.fallbackModuleFilenameTemplate || "webpack:///[resourcePath]?[hash]";
	this.options = options;
}
module.exports = SourceMapDevToolPlugin;
SourceMapDevToolPlugin.prototype.apply = function(compiler) {
	var sourceMapFilename = this.sourceMapFilename;
	var sourceMappingURLComment = this.sourceMappingURLComment;
	var moduleFilenameTemplate = this.moduleFilenameTemplate;
	var fallbackModuleFilenameTemplate = this.fallbackModuleFilenameTemplate;
	var requestShortener = new RequestShortener(compiler.context);
	var options = this.options;
	options.test = options.test || /\.(js|css)($|\?)/i;
	compiler.plugin("compilation", function(compilation) {
		new SourceMapDevToolModuleOptionsPlugin(options).apply(compilation);
		compilation.plugin("after-optimize-chunk-assets", function(chunks) {
			var allModules = [];
			var allModuleFilenames = [];
			function getSourceAndMap(asset) {
				var source;
				var sourceMap;
				if(asset.sourceAndMap) {
					var sourceAndMap = asset.sourceAndMap(options);
					sourceMap = sourceAndMap.map;
					source = sourceAndMap.source;
				} else {
					sourceMap = asset.map(options);
					source = asset.source();
				}

				return {source: source, sourceMap: sourceMap};
			}
			function getModulesWithFilenames(sourceMap) {
				var modules = sourceMap.sources.map(function(source) {
					var module = compilation.findModule(source);
					return module || source;
				});
				var moduleFilenames = modules.map(function(module) {
					return ModuleFilenameHelpers.createFilename(module, moduleFilenameTemplate, requestShortener);
				});

				return {modules: modules, moduleFilenames: moduleFilenames}
			}

			var outputPath = this.getPath(compiler.outputPath);
			compiler.outputFileSystem.mkdirp(outputPath, function() {
				chunks.forEach(function(chunk) {
					var files = chunk.files.filter(ModuleFilenameHelpers.matchObject.bind(undefined, options))
					files.forEach(function(file) {
						var {source, sourceMap} = getSourceAndMap(this.assets[file]);
						if(sourceMap) {
							var {modules, moduleFilenames} = getModulesWithFilenames(sourceMap);
							allModules = allModules.concat(modules);
							allModuleFilenames = allModuleFilenames.concat(moduleFilenames);
						}
					}, this);
					allModuleFilenames = ModuleFilenameHelpers.replaceDuplicates(allModuleFilenames, function(filename, i) {
						return ModuleFilenameHelpers.createFilename(allModules[i], fallbackModuleFilenameTemplate, requestShortener);
					}, function(ai, bi) {
						var a = allModules[ai];
						var b = allModules[bi];
						a = !a ? "" : typeof a === "string" ? a : a.identifier();
						b = !b ? "" : typeof b === "string" ? b : b.identifier();
						return a.length - b.length;
					});
					allModuleFilenames = ModuleFilenameHelpers.replaceDuplicates(allModuleFilenames, function(filename, i, n) {
						for(var j = 0; j < n; j++)
							filename += "*";
						return filename;
					});
					files.forEach(function(file) {
						var asset = this.assets[file];
						var {source, sourceMap} = getSourceAndMap(asset);
						if(sourceMap) {
							var {modules, moduleFilenames} = getModulesWithFilenames(sourceMap);
							moduleFilenames = allModuleFilenames.slice(0, moduleFilenames.length);
							allModuleFilenames = allModuleFilenames.slice(moduleFilenames.length);
							modules = modules.slice(0, moduleFilenames.length);
							allModules = allModules.slice(moduleFilenames.length);
							sourceMap.sources = moduleFilenames;
							if(sourceMap.sourcesContent && !options.noSources) {
								sourceMap.sourcesContent = sourceMap.sourcesContent.map(function(content, i) {
									return content + "\n\n\n" + ModuleFilenameHelpers.createFooter(modules[i], requestShortener);
								});
							} else {
								sourceMap.sourcesContent = undefined;
							}
							sourceMap.sourceRoot = options.sourceRoot || "";
							var currentSourceMappingURLComment = sourceMappingURLComment;
							if(currentSourceMappingURLComment !== false && /\.css($|\?)/i.test(file)) {
								currentSourceMappingURLComment = currentSourceMappingURLComment.replace(/^\n\/\/(.*)$/, "\n/*$1*/");
							}
							if(sourceMapFilename) {
								var filename = file,
									query = "";
								var idx = filename.indexOf("?");
								if(idx >= 0) {
									query = filename.substr(idx);
									filename = filename.substr(0, idx);
								}
								var sourceMapFile = this.getPath(sourceMapFilename, {
									chunk: chunk,
									filename: filename,
									query: query,
									basename: basename(filename)
								});
								var sourceMapUrl = path.relative(path.dirname(file), sourceMapFile).replace(/\\/g, "/");
								if(currentSourceMappingURLComment !== false) {
									delete this.assets[file];
									this.assets[file] = new ConcatSource(new RawSource(source), currentSourceMappingURLComment.replace(/\[url\]/g, sourceMapUrl));
								}
								var sourceMapContent= new RawSource(JSON.stringify(sourceMap));
								var content = sourceMapContent.source();

								if(!Buffer.isBuffer(content)) {
									content = new Buffer(content, "utf8"); //eslint-disable-line
								}

								delete sourceMapContent;
								var targetPath = compiler.outputFileSystem.join(outputPath, sourceMapFile);
								compiler.outputFileSystem.writeFile(targetPath, content);
								chunk.files.push(sourceMapFile);
							} else {
								this.assets[file] = new ConcatSource(new RawSource(source), currentSourceMappingURLComment
									.replace(/\[map\]/g, function() {
										return JSON.stringify(sourceMap);
									})
									.replace(/\[url\]/g, function() {
										return "data:application/json;charset=utf-8;base64," +
											new Buffer(JSON.stringify(sourceMap), "utf8").toString("base64"); //eslint-disable-line
									})
								);
							}
							sourceMap.file = file;
						}
					}, this);
				}, this);
			}.bind(this));
		});
	});
};

function basename(name) {
	if(name.indexOf("/") < 0) return name;
	return name.substr(name.lastIndexOf("/") + 1);
}
