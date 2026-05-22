import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-CEuC9fQG.js";
//#region src/agents/anthropic-vertex-stream.ts
function loadAnthropicVertexStreamFacade() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "anthropic-vertex",
		artifactBasename: "api.js"
	});
}
function createAnthropicVertexStreamFnForModel(model, env = process.env) {
	return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFnForModel(model, env);
}
//#endregion
export { createAnthropicVertexStreamFnForModel as t };
