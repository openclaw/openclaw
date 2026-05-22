import { f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-BvxMxU5i.js";
import { f as resolveXaiModelCompatPatch$1 } from "./provider-tools-AcSjASfb.js";
import { o as getModelProviderHint } from "./provider-model-shared-DcESXin-.js";
import "./text-runtime-BwGO-OOf.js";
import "./model-definitions-XkpnVG1H.js";
import "./provider-catalog-CAnP-eyL.js";
import "./onboard-BW9dLayF.js";
import "./image-generation-provider-C-VkY3b9.js";
import "./runtime-model-compat-MSxJAJSG.js";
import "./provider-models-BuvCPzL8.js";
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
