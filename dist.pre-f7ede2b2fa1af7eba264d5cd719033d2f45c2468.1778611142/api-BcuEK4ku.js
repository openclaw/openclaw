import { t as hasAnthropicVertexAvailableAuth } from "./region-udFLwhHJ.js";
import { n as buildAnthropicVertexProvider } from "./provider-catalog-DCcpo-aM.js";
//#region extensions/anthropic-vertex/api.ts
function mergeImplicitAnthropicVertexProvider(params) {
	const { existing, implicit } = params;
	if (!existing) return implicit;
	return {
		...implicit,
		...existing,
		models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : implicit.models
	};
}
function resolveImplicitAnthropicVertexProvider(params) {
	const env = params?.env ?? process.env;
	if (!hasAnthropicVertexAvailableAuth(env)) return null;
	return buildAnthropicVertexProvider({ env });
}
function createAnthropicVertexStreamFn(projectId, region, baseURL, deps) {
	const streamFnPromise = import("./extensions/anthropic-vertex/stream-runtime.js").then((runtime) => runtime.createAnthropicVertexStreamFn(projectId, region, baseURL, deps));
	return async (model, context, options) => {
		return (await streamFnPromise)(model, context, options);
	};
}
function createAnthropicVertexStreamFnForModel(model, env = process.env, deps) {
	const streamFnPromise = import("./extensions/anthropic-vertex/stream-runtime.js").then((runtime) => runtime.createAnthropicVertexStreamFnForModel(model, env, deps));
	return async (...args) => {
		return (await streamFnPromise)(...args);
	};
}
//#endregion
export { resolveImplicitAnthropicVertexProvider as i, createAnthropicVertexStreamFnForModel as n, mergeImplicitAnthropicVertexProvider as r, createAnthropicVertexStreamFn as t };
