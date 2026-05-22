import { f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import "./provider-model-shared-BDPvUGt6.js";
import "./string-coerce-runtime-Dpi9hISx.js";
import "./model-compat-WLnNIE7H.js";
import "./model-definitions-Cr51bqK8.js";
import "./provider-catalog-DaF86_2G.js";
import "./onboard-DJZThBUz.js";
import "./image-generation-provider-CYuTcXWc.js";
import "./runtime-model-compat-DeGDXKLl.js";
import "./provider-models-BF9iXIhv.js";
//#region extensions/xai/api.ts
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
function getModelProviderHint(modelId) {
	const trimmed = normalizeOptionalLowercaseString(modelId);
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return null;
	return trimmed.slice(0, slashIndex) || null;
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
export { shouldContributeXaiCompat as i, resolveXaiBaseUrl as n, resolveXaiTransport as r, isXaiModelHint as t };
