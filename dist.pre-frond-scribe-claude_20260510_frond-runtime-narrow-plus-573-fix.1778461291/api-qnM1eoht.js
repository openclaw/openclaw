import { f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-C3dkeX_L.js";
import { f as resolveXaiModelCompatPatch$1 } from "./provider-tools-DgOkcG5J.js";
import { o as getModelProviderHint } from "./provider-model-shared-BJrHvRZi.js";
import "./text-runtime-CEUy8PW0.js";
import "./model-definitions-CxR1g8pD.js";
import "./provider-catalog-kVF7R2P5.js";
import "./onboard-Cbel4Ccj.js";
import "./image-generation-provider-dNrFfO8H.js";
import "./runtime-model-compat-BLk09d4p.js";
import "./provider-models-BEANAzns.js";
//#region extensions/xai/api.ts
const resolveXaiModelCompatPatch = resolveXaiModelCompatPatch$1;
const XAI_NATIVE_ENDPOINT_HOSTS = new Set(["api.x.ai", "api.grok.x.ai"]);
function resolveHostname(value) {
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return;
	}
}
function isXaiNativeEndpoint(baseUrl) {
	return typeof baseUrl === "string" && XAI_NATIVE_ENDPOINT_HOSTS.has(resolveHostname(baseUrl) ?? "");
}
function isXaiModelHint(modelId) {
	return getModelProviderHint(modelId) === "x-ai";
}
function shouldUseXaiResponsesTransport(params) {
	if (params.api !== "openai-completions") return false;
	if (isXaiNativeEndpoint(params.baseUrl)) return true;
	return normalizeProviderId(params.provider) === "xai" && !params.baseUrl;
}
function shouldContributeXaiCompat(params) {
	if (params.model.api !== "openai-completions") return false;
	return isXaiNativeEndpoint(params.model.baseUrl) || isXaiModelHint(params.modelId);
}
function resolveXaiTransport(params) {
	if (!shouldUseXaiResponsesTransport(params)) return;
	return {
		api: "openai-responses",
		baseUrl: readStringValue(params.baseUrl)
	};
}
function resolveXaiBaseUrl(baseUrlOrConfig) {
	let candidate = baseUrlOrConfig;
	if (baseUrlOrConfig && typeof baseUrlOrConfig === "object" && !Array.isArray(baseUrlOrConfig) && "cfg" in baseUrlOrConfig) candidate = baseUrlOrConfig.cfg?.models?.providers?.xai?.baseUrl ?? baseUrlOrConfig;
	return readStringValue(candidate) || "https://api.x.ai/v1";
}
//#endregion
export { shouldContributeXaiCompat as a, resolveXaiTransport as i, resolveXaiBaseUrl as n, resolveXaiModelCompatPatch as r, isXaiModelHint as t };
