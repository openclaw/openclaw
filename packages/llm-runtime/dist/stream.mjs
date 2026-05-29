import { getApiProvider } from "./api-registry.mjs";
//#region packages/llm-runtime/src/stream.ts
function resolveApiProvider(api) {
	const provider = getApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return provider;
}
function stream(model, context, options) {
	return resolveApiProvider(model.api).stream(model, context, options);
}
async function complete(model, context, options) {
	return stream(model, context, options).result();
}
function streamSimple(model, context, options) {
	return resolveApiProvider(model.api).streamSimple(model, context, options);
}
async function completeSimple(model, context, options) {
	return streamSimple(model, context, options).result();
}
//#endregion
export { complete, completeSimple, stream, streamSimple };
