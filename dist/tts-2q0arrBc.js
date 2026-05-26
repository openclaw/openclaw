import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-C90BH-le.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/minimax/tts.ts
const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";
const MINIMAX_TTS_MODELS = [
	"speech-2.8-hd",
	"speech-2.8-turbo",
	"speech-2.6-hd",
	"speech-2.6-turbo",
	"speech-02-hd",
	"speech-02-turbo",
	"speech-01-hd",
	"speech-01-turbo",
	"speech-01-240228"
];
const MINIMAX_TTS_VOICES = [
	"English_expressive_narrator",
	"Chinese (Mandarin)_Warm_Girl",
	"Chinese (Mandarin)_Lively_Girl",
	"Chinese (Mandarin)_Gentle_Boy",
	"Chinese (Mandarin)_Steady_Boy"
];
function normalizeMinimaxTtsBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return DEFAULT_MINIMAX_TTS_BASE_URL;
	return trimmed.replace(/\/+$/, "").replace(/\/(?:anthropic|v1)$/i, "");
}
function normalizeMinimaxTtsPitch(pitch) {
	return Math.trunc(pitch);
}
async function minimaxTTS(params) {
	const { text, apiKey, baseUrl, model, voiceId, speed = 1, vol = 1, pitch = 0, format = "mp3", sampleRate = 32e3, timeoutMs } = params;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: `${baseUrl}/v1/t2a_v2`,
			init: {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					text,
					voice_setting: {
						voice_id: voiceId,
						speed,
						vol,
						pitch: normalizeMinimaxTtsPitch(pitch)
					},
					audio_setting: {
						format,
						sample_rate: sampleRate
					}
				}),
				signal: controller.signal
			},
			timeoutMs,
			policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
			auditContext: "minimax.tts"
		});
		try {
			await assertOkOrThrowProviderError(response, "MiniMax TTS API error");
			const hexAudio = (await response.json())?.data?.audio;
			if (!hexAudio) throw new Error("MiniMax TTS API returned no audio data");
			return Buffer.from(hexAudio, "hex");
		} finally {
			await release();
		}
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
export { normalizeMinimaxTtsBaseUrl as a, minimaxTTS as i, MINIMAX_TTS_MODELS as n, MINIMAX_TTS_VOICES as r, DEFAULT_MINIMAX_TTS_BASE_URL as t };
