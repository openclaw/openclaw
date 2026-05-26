import { _ as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-CYoLqc2K.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-B7xT8hT9.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-B_ZYSMaC.js";
import "./ssrf-runtime-B7YsbRmp.js";
import { i as requireInRange, n as normalizeLanguageCode, r as normalizeSeed, t as normalizeApplyTextNormalization } from "./tts-provider-helpers--hs19-45.js";
import "./provider-http-BWEeBX6j.js";
import "./speech-BduO54XN.js";
import { n as isValidElevenLabsVoiceId, r as normalizeElevenLabsBaseUrl } from "./shared-CndKvPu4.js";
//#region extensions/elevenlabs/tts.ts
function assertElevenLabsVoiceSettings(settings) {
	requireInRange(settings.stability, 0, 1, "stability");
	requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
	requireInRange(settings.style, 0, 1, "style");
	requireInRange(settings.speed, .5, 2, "speed");
}
function resolveElevenLabsAcceptHeader(outputFormat) {
	const normalized = outputFormat.trim().toLowerCase();
	if (!normalized || normalized.startsWith("mp3_")) return "audio/mpeg";
}
function prepareElevenLabsTtsRequest(params) {
	const { text, baseUrl, voiceId, modelId, outputFormat, seed, applyTextNormalization, languageCode, latencyTier, voiceSettings } = params;
	if (!isValidElevenLabsVoiceId(voiceId)) throw new Error("Invalid voiceId format");
	assertElevenLabsVoiceSettings(voiceSettings);
	const normalizedLanguage = normalizeLanguageCode(languageCode);
	const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
	const normalizedSeed = normalizeSeed(seed);
	const normalizedBaseUrl = normalizeElevenLabsBaseUrl(baseUrl);
	const normalizedLatencyTier = typeof latencyTier === "number" && Number.isFinite(latencyTier) ? Math.trunc(latencyTier) : void 0;
	if (normalizedLatencyTier !== void 0) requireInRange(normalizedLatencyTier, 0, 4, "latencyTier");
	const url = new URL(`${normalizedBaseUrl}/v1/text-to-speech/${voiceId}${params.stream ? "/stream" : ""}`);
	if (outputFormat) url.searchParams.set("output_format", outputFormat);
	const supportsStreamingLatency = modelId.trim().toLowerCase() !== "eleven_v3";
	if (normalizedLatencyTier !== void 0 && supportsStreamingLatency) url.searchParams.set("optimize_streaming_latency", normalizedLatencyTier.toString());
	return {
		url,
		normalizedBaseUrl,
		acceptHeader: resolveElevenLabsAcceptHeader(outputFormat),
		body: JSON.stringify({
			text,
			model_id: modelId,
			seed: normalizedSeed,
			apply_text_normalization: normalizedNormalization,
			language_code: normalizedLanguage,
			voice_settings: {
				stability: voiceSettings.stability,
				similarity_boost: voiceSettings.similarityBoost,
				style: voiceSettings.style,
				use_speaker_boost: voiceSettings.useSpeakerBoost,
				speed: voiceSettings.speed
			}
		})
	};
}
async function elevenLabsTTS(params) {
	const { apiKey, timeoutMs } = params;
	const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
		...params,
		stream: false
	});
	const { response, release } = await fetchWithSsrFGuard({
		url: url.toString(),
		init: {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				...acceptHeader ? { Accept: acceptHeader } : {}
			},
			body
		},
		timeoutMs,
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
		auditContext: "elevenlabs.tts"
	});
	try {
		await assertOkOrThrowProviderError(response, "ElevenLabs API error");
		return Buffer.from(await response.arrayBuffer());
	} finally {
		await release();
	}
}
async function elevenLabsTTSStream(params) {
	const { apiKey, timeoutMs } = params;
	const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
		...params,
		stream: true
	});
	const { response, release } = await fetchWithSsrFGuard({
		url: url.toString(),
		init: {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				...acceptHeader ? { Accept: acceptHeader } : {}
			},
			body
		},
		timeoutMs,
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
		auditContext: "elevenlabs.tts.stream"
	});
	let handedOff = false;
	try {
		await assertOkOrThrowProviderError(response, "ElevenLabs API error");
		if (!response.body) throw new Error("ElevenLabs API response missing audio stream");
		handedOff = true;
		return {
			audioStream: response.body,
			release
		};
	} finally {
		if (!handedOff) await release();
	}
}
//#endregion
export { elevenLabsTTSStream as n, elevenLabsTTS as t };
