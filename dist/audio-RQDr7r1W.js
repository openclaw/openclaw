import { r as assertOkOrThrowHttpError } from "./provider-http-errors-B_ZYSMaC.js";
import { c as requireTranscriptionText, s as postTranscriptionRequest, u as resolveProviderHttpRequestConfig } from "./shared-BtBXLREr.js";
import "./provider-http-BWEeBX6j.js";
//#region extensions/deepgram/audio.ts
const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";
function resolveModel(model) {
	return model?.trim() || "nova-3";
}
async function transcribeDeepgramAudio(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const model = resolveModel(params.model);
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: params.baseUrl,
		defaultBaseUrl: DEFAULT_DEEPGRAM_AUDIO_BASE_URL,
		headers: params.headers,
		request: params.request,
		defaultHeaders: {
			authorization: `Token ${params.apiKey}`,
			"content-type": params.mime ?? "application/octet-stream"
		},
		provider: "deepgram",
		capability: "audio",
		transport: "media-understanding"
	});
	const url = new URL(`${baseUrl}/listen`);
	url.searchParams.set("model", model);
	if (params.language?.trim()) url.searchParams.set("language", params.language.trim());
	if (params.query) for (const [key, value] of Object.entries(params.query)) {
		if (value === void 0) continue;
		url.searchParams.set(key, String(value));
	}
	const body = new Uint8Array(params.buffer);
	const { response: res, release } = await postTranscriptionRequest({
		url: url.toString(),
		headers,
		body,
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork,
		dispatcherPolicy
	});
	try {
		await assertOkOrThrowHttpError(res, "Audio transcription failed");
		return {
			text: requireTranscriptionText((await res.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript, "Audio transcription response missing transcript"),
			model
		};
	} finally {
		await release();
	}
}
//#endregion
export { DEFAULT_DEEPGRAM_AUDIO_MODEL as n, transcribeDeepgramAudio as r, DEFAULT_DEEPGRAM_AUDIO_BASE_URL as t };
