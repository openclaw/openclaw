import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./image-runtime-Dye6Uj6e.js";
import { p as readProviderJsonObjectResponse, r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { d as requireTranscriptionText, p as resolveProviderHttpRequestConfig, t as buildAudioTranscriptionFormData, u as postTranscriptionRequest } from "./shared-D8kCtbT2.js";
//#region src/media-understanding/openai-compatible-video.ts
function resolveMediaUnderstandingString(value, fallback) {
	return normalizeOptionalString(value) || fallback;
}
function coerceOpenAiCompatibleVideoText(payload) {
	const message = payload.choices?.[0]?.message;
	if (!message) return null;
	if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
	if (Array.isArray(message.content)) {
		const text = message.content.map((part) => typeof part.text === "string" ? part.text.trim() : "").filter(Boolean).join("\n").trim();
		if (text) return text;
	}
	if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content.trim();
	return null;
}
function buildOpenAiCompatibleVideoRequestBody(params) {
	return {
		model: params.model,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: params.prompt
			}, {
				type: "video_url",
				video_url: { url: `data:${params.mime};base64,${params.buffer.toString("base64")}` }
			}]
		}]
	};
}
//#endregion
//#region src/media-understanding/openai-compatible-audio.ts
function resolveModel(model, fallback) {
	return model?.trim() || fallback;
}
async function transcribeOpenAiCompatibleAudio(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: params.baseUrl,
		defaultBaseUrl: params.defaultBaseUrl,
		headers: params.headers,
		request: params.request,
		defaultHeaders: { authorization: `Bearer ${params.apiKey}` },
		provider: params.provider,
		api: "openai-audio-transcriptions",
		capability: "audio",
		transport: "media-understanding"
	});
	const url = `${baseUrl}/audio/transcriptions`;
	const model = resolveModel(params.model, params.defaultModel);
	const { response: res, release } = await postTranscriptionRequest({
		url,
		headers,
		body: buildAudioTranscriptionFormData({
			buffer: params.buffer,
			fileName: params.fileName,
			mime: params.mime,
			fields: {
				model,
				language: params.language,
				prompt: params.prompt
			}
		}),
		timeoutMs: params.timeoutMs,
		fetchFn,
		pinDns: false,
		allowPrivateNetwork,
		dispatcherPolicy
	});
	try {
		await assertOkOrThrowHttpError(res, "Audio transcription failed");
		const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed");
		return {
			text: requireTranscriptionText(typeof payload.text === "string" ? payload.text : void 0, "Audio transcription response missing text"),
			model
		};
	} finally {
		await release();
	}
}
//#endregion
export { resolveMediaUnderstandingString as i, buildOpenAiCompatibleVideoRequestBody as n, coerceOpenAiCompatibleVideoText as r, transcribeOpenAiCompatibleAudio as t };
