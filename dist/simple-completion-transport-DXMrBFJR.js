import { a as ensureCustomApiRegistered, i as prepareTransportAwareSimpleModel, n as buildTransportAwareSimpleStreamFn, t as registerProviderStreamForModel } from "./provider-stream-qFQv-LxD.js";
import { t as createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream-Cs6RnR5d.js";
import { getApiProvider } from "@earendil-works/pi-ai";
//#region src/agents/simple-completion-transport.ts
function resolveAnthropicVertexSimpleApi(baseUrl) {
	return `openclaw-anthropic-vertex-simple:${baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default"}`;
}
function prepareModelForSimpleCompletion(params) {
	const { model, cfg } = params;
	if (!getApiProvider(model.api) && registerProviderStreamForModel({
		model,
		cfg
	})) return model;
	const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
	if (transportAwareModel !== model) {
		const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
		if (streamFn) {
			ensureCustomApiRegistered(transportAwareModel.api, streamFn);
			return transportAwareModel;
		}
	}
	if (model.provider === "anthropic-vertex") {
		const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
		ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
		return {
			...model,
			api
		};
	}
	return model;
}
//#endregion
export { prepareModelForSimpleCompletion as t };
