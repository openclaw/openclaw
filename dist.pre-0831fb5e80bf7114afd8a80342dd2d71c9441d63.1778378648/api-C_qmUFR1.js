import { f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-C3dkeX_L.js";
import { f as resolveXaiModelCompatPatch$1 } from "./provider-tools-CUksBU_o.js";
import { o as getModelProviderHint } from "./provider-model-shared-CaJQJU2U.js";
import "./text-runtime-Dm9-PE_c.js";
import "./model-definitions-C2Yq2Te0.js";
import "./provider-catalog-DLKgsQiZ.js";
import "./onboard-K-1ENzuG.js";
import "./image-generation-provider-DTtNlpAx.js";
import "./runtime-model-compat-DlIdGQAb.js";
import "./provider-models-C3ryM0n8.js";
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
