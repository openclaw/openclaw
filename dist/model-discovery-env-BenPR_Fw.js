//#region extensions/chutes/model-discovery-env.ts
function isChutesModelDiscoveryTestEnvironment(env = process.env) {
	return env.NODE_ENV === "test" || env.VITEST === "true";
}
//#endregion
export { isChutesModelDiscoveryTestEnvironment as t };
