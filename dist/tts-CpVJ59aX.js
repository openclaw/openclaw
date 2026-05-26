import { s as resolveProviderRequestHeaders } from "./provider-request-config-DgQ_QSz5.js";
import { _ as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-CYoLqc2K.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-B7xT8hT9.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-B_ZYSMaC.js";
import { a as isDebugProxyGlobalFetchPatchInstalled, t as captureHttpExchange } from "./runtime-SdFfflZw.js";
import "./proxy-capture-CAV3eJhm.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./provider-http-BWEeBX6j.js";
//#region extensions/openai/tts.ts
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_TTS_MODELS = [
	"gpt-4o-mini-tts",
	"tts-1",
	"tts-1-hd"
];
const OPENAI_TTS_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"cedar",
	"coral",
	"echo",
	"fable",
	"juniper",
	"marin",
	"onyx",
	"nova",
	"sage",
	"shimmer",
	"verse"
];
function normalizeOpenAITtsBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_OPENAI_BASE_URL;
	return trimmed.replace(/\/+$/, "");
}
function isCustomOpenAIEndpoint(baseUrl) {
	if (baseUrl != null) return normalizeOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_BASE_URL;
	return normalizeOpenAITtsBaseUrl(process.env.OPENAI_TTS_BASE_URL) !== DEFAULT_OPENAI_BASE_URL;
}
function isValidOpenAIModel(model, baseUrl) {
	if (isCustomOpenAIEndpoint(baseUrl)) return true;
	return OPENAI_TTS_MODELS.includes(model);
}
function isValidOpenAIVoice(voice, baseUrl) {
	if (isCustomOpenAIEndpoint(baseUrl)) return true;
	return OPENAI_TTS_VOICES.includes(voice);
}
function resolveOpenAITtsInstructions(model, instructions, baseUrl) {
	const next = instructions?.trim();
	if (!next) return;
	if (baseUrl !== void 0 && isCustomOpenAIEndpoint(baseUrl)) return next;
	return model.includes("gpt-4o-mini-tts") ? next : void 0;
}
function sanitizeExtraBodyRecord(value) {
	const sanitized = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		sanitized[key] = entry;
	}
	return sanitized;
}
async function openaiTTS(params) {
	const { text, apiKey, baseUrl, model, voice, speed, instructions, responseFormat, extraBody, timeoutMs } = params;
	const effectiveInstructions = resolveOpenAITtsInstructions(model, instructions, baseUrl);
	if (!isValidOpenAIModel(model, baseUrl)) throw new Error(`Invalid model: ${model}`);
	if (!isValidOpenAIVoice(voice, baseUrl)) throw new Error(`Invalid voice: ${voice}`);
	const requestHeaders = resolveProviderRequestHeaders({
		provider: "openai",
		baseUrl,
		capability: "audio",
		transport: "http",
		defaultHeaders: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		}
	}) ?? {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json"
	};
	const requestBody = JSON.stringify({
		model,
		input: text,
		voice,
		response_format: responseFormat,
		...speed != null && { speed },
		...effectiveInstructions != null && { instructions: effectiveInstructions },
		...extraBody == null ? {} : sanitizeExtraBodyRecord(extraBody)
	});
	const requestUrl = `${baseUrl}/audio/speech`;
	const debugProxyFetchPatchInstalled = isDebugProxyGlobalFetchPatchInstalled();
	const { response, release } = await fetchWithSsrFGuard({
		url: requestUrl,
		init: {
			method: "POST",
			headers: requestHeaders,
			body: requestBody
		},
		timeoutMs,
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
		capture: false,
		pinDns: debugProxyFetchPatchInstalled ? false : void 0,
		auditContext: "openai-tts"
	});
	try {
		if (!debugProxyFetchPatchInstalled) captureHttpExchange({
			url: requestUrl,
			method: "POST",
			requestHeaders,
			requestBody,
			response,
			transport: "http",
			meta: {
				provider: "openai",
				capability: "tts"
			}
		});
		await assertOkOrThrowProviderError(response, "OpenAI TTS API error");
		return Buffer.from(await response.arrayBuffer());
	} finally {
		await release();
	}
}
//#endregion
export { isValidOpenAIVoice as a, resolveOpenAITtsInstructions as c, isValidOpenAIModel as i, OPENAI_TTS_MODELS as n, normalizeOpenAITtsBaseUrl as o, OPENAI_TTS_VOICES as r, openaiTTS as s, DEFAULT_OPENAI_BASE_URL as t };
