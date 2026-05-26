//#region extensions/huggingface/model-discovery-env.ts
function isHuggingfaceModelDiscoveryTestEnvironment(env = process.env) {
	return env.VITEST === "true" || env.NODE_ENV === "test";
}
//#endregion
export { isHuggingfaceModelDiscoveryTestEnvironment as t };
