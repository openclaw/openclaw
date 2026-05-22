import { s as __toESM } from "./chunk-A-jGZS85.js";
//#region extensions/amazon-bedrock/aws-credential-refresh.ts
let sharedIniFileLoaderForTest;
function hasStaticAwsCredentialEnv(env) {
	return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}
function shouldRefreshAwsSharedConfigCacheForBedrock(env) {
	if (env.AWS_BEDROCK_SKIP_AUTH === "1" || env.AWS_BEARER_TOKEN_BEDROCK) return false;
	return !hasStaticAwsCredentialEnv(env);
}
async function loadSharedIniFileLoader() {
	if (sharedIniFileLoaderForTest !== void 0) {
		if (!sharedIniFileLoaderForTest) throw new Error("AWS shared INI file loader unavailable");
		return sharedIniFileLoaderForTest;
	}
	return await import("./dist-cjs-D89LKnCn.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1));
}
async function refreshAwsSharedConfigCacheForBedrock(env = process.env) {
	if (!shouldRefreshAwsSharedConfigCacheForBedrock(env)) return;
	await (await loadSharedIniFileLoader()).loadSharedConfigFiles({ ignoreCache: true });
}
function setAwsSharedIniFileLoaderForTest(loader) {
	sharedIniFileLoaderForTest = loader;
}
//#endregion
export { setAwsSharedIniFileLoaderForTest as n, shouldRefreshAwsSharedConfigCacheForBedrock as r, refreshAwsSharedConfigCacheForBedrock as t };
