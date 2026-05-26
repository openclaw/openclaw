import { p as readProviderJsonObjectResponse, r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { d as requireTranscriptionText, p as resolveProviderHttpRequestConfig, u as postTranscriptionRequest } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/deepgram/audio.ts
const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";
function resolveModel(model) {
	return model?.trim() || "nova-3";
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function readDeepgramTranscript(payload) {
	const results = asRecord(payload.results);
	if (!results) return;
	if (!Array.isArray(results.channels)) throw new Error("Audio transcription failed: malformed JSON response");
	const channel = asRecord(results.channels[0]);
	if (!channel) return;
	if (!Array.isArray(channel.alternatives)) throw new Error("Audio transcription failed: malformed JSON response");
	const alternative = asRecord(channel.alternatives[0]);
	if (!alternative) return;
	if (alternative.transcript !== void 0 && typeof alternative.transcript !== "string") throw new Error("Audio transcription failed: malformed JSON response");
	return alternative.transcript;
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
			text: requireTranscriptionText(readDeepgramTranscript(await readProviderJsonObjectResponse(res, "Audio transcription failed")), "Audio transcription response missing transcript"),
			model
		};
	} finally {
		await release();
	}
}
//#endregion
export { DEFAULT_DEEPGRAM_AUDIO_MODEL as n, transcribeDeepgramAudio as r, DEFAULT_DEEPGRAM_AUDIO_BASE_URL as t };
