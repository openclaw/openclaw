import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-B_ZYSMaC.js";
import { c as requireTranscriptionText, s as postTranscriptionRequest, t as buildAudioTranscriptionFormData, u as resolveProviderHttpRequestConfig } from "./shared-BtBXLREr.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./provider-http-BWEeBX6j.js";
import { t as XAI_BASE_URL } from "./model-definitions-DmV6zJgC.js";
//#region extensions/xai/stt.ts
const XAI_DEFAULT_STT_MODEL = "grok-stt";
function resolveXaiSttBaseUrl(value) {
	return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? "https://api.x.ai/v1";
}
async function transcribeXaiAudio(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: resolveXaiSttBaseUrl(params.baseUrl),
		defaultBaseUrl: XAI_BASE_URL,
		headers: params.headers,
		request: params.request,
		defaultHeaders: { Authorization: `Bearer ${params.apiKey}` },
		provider: "xai",
		api: "xai-stt",
		capability: "audio",
		transport: "media-understanding"
	});
	const model = normalizeOptionalString(params.model);
	const language = normalizeOptionalString(params.language);
	const form = buildAudioTranscriptionFormData({
		buffer: params.buffer,
		fileName: params.fileName,
		mime: params.mime,
		fields: {
			model,
			language
		}
	});
	const { response, release } = await postTranscriptionRequest({
		url: `${baseUrl}/stt`,
		headers,
		body: form,
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork,
		dispatcherPolicy,
		auditContext: "xai stt"
	});
	try {
		await assertOkOrThrowHttpError(response, "xAI audio transcription failed");
		return {
			text: requireTranscriptionText((await response.json()).text, "xAI transcription response missing text"),
			...model ? { model } : {}
		};
	} finally {
		await release();
	}
}
function buildXaiMediaUnderstandingProvider() {
	return {
		id: "xai",
		capabilities: ["audio"],
		defaultModels: { audio: XAI_DEFAULT_STT_MODEL },
		autoPriority: { audio: 25 },
		transcribeAudio: transcribeXaiAudio
	};
}
//#endregion
export { buildXaiMediaUnderstandingProvider as n, transcribeXaiAudio as r, XAI_DEFAULT_STT_MODEL as t };
