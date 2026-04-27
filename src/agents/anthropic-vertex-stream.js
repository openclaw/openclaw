import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-loader.js";
function loadAnthropicVertexStreamFacade() {
    return loadBundledPluginPublicSurfaceModuleSync({
        dirName: "anthropic-vertex",
        artifactBasename: "api.js",
    });
}
export function createAnthropicVertexStreamFn(projectId, region, baseURL) {
    return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFn(projectId, region, baseURL);
}
export function createAnthropicVertexStreamFnForModel(model, env = process.env) {
    return loadAnthropicVertexStreamFacade().createAnthropicVertexStreamFnForModel(model, env);
}
