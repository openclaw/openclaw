import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import { t as createRealtimeTranscriptionWebSocketSession } from "./realtime-transcription-BUDe2hRe.js";
//#region extensions/mistral/realtime-transcription-provider.ts
const MISTRAL_REALTIME_DEFAULT_BASE_URL = "wss://api.mistral.ai";
const MISTRAL_REALTIME_DEFAULT_MODEL = "voxtral-mini-transcribe-realtime-2602";
const MISTRAL_REALTIME_DEFAULT_SAMPLE_RATE = 8e3;
const MISTRAL_REALTIME_DEFAULT_ENCODING = "pcm_mulaw";
const MISTRAL_REALTIME_DEFAULT_DELAY_MS = 800;
const MISTRAL_REALTIME_CONNECT_TIMEOUT_MS = 1e4;
const MISTRAL_REALTIME_CLOSE_TIMEOUT_MS = 5e3;
const MISTRAL_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const MISTRAL_REALTIME_RECONNECT_DELAY_MS = 1e3;
const MISTRAL_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
function readRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readNestedMistralConfig(rawConfig) {
	const raw = readRecord(rawConfig);
	return readRecord(readRecord(raw?.providers)?.mistral ?? raw?.mistral ?? raw) ?? {};
}
function readFiniteNumber(value) {
	const next = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : void 0;
	return Number.isFinite(next) ? next : void 0;
}
function normalizeMistralEncoding(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	if (!normalized) return;
	switch (normalized) {
		case "pcm":
		case "linear16":
		case "pcm_s16le": return "pcm_s16le";
		case "pcm_s32le":
		case "pcm_f16le":
		case "pcm_f32le": return normalized;
		case "mulaw":
		case "ulaw":
		case "g711_ulaw":
		case "g711-mulaw":
		case "pcm_mulaw": return "pcm_mulaw";
		case "alaw":
		case "g711_alaw":
		case "g711-alaw":
		case "pcm_alaw": return "pcm_alaw";
		default: throw new Error(`Invalid Mistral realtime transcription encoding: ${normalized}`);
	}
}
function normalizeMistralRealtimeBaseUrl(value) {
	const raw = normalizeOptionalString(value ?? process.env.MISTRAL_REALTIME_BASE_URL);
	if (!raw) return MISTRAL_REALTIME_DEFAULT_BASE_URL;
	const url = new URL(raw);
	url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
	url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
	return url.toString().replace(/\/+$/, "");
}
function toMistralRealtimeWsUrl(config) {
	const base = new URL(`${normalizeMistralRealtimeBaseUrl(config.baseUrl)}/`);
	const url = new URL("v1/audio/transcriptions/realtime", base);
	url.searchParams.set("model", config.model);
	if (config.targetStreamingDelayMs != null) url.searchParams.set("target_streaming_delay_ms", String(config.targetStreamingDelayMs));
	return url.toString();
}
function normalizeProviderConfig(config) {
	const raw = readNestedMistralConfig(config);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw.apiKey,
			path: "plugins.entries.voice-call.config.streaming.providers.mistral.apiKey"
		}),
		baseUrl: normalizeOptionalString(raw.baseUrl),
		model: normalizeOptionalString(raw.model ?? raw.sttModel),
		sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
		encoding: normalizeMistralEncoding(raw.encoding),
		targetStreamingDelayMs: readFiniteNumber(raw.targetStreamingDelayMs ?? raw.target_streaming_delay_ms ?? raw.delayMs)
	};
}
function readErrorDetail(event) {
	const message = event.error?.message;
	if (typeof message === "string") return message;
	if (message && typeof message === "object") return JSON.stringify(message);
	if (typeof event.error?.code === "number") return `Mistral realtime transcription error (${event.error.code})`;
	return "Mistral realtime transcription error";
}
function createMistralRealtimeTranscriptionSession(config) {
	let partialText = "";
	const handleEvent = (event, transport) => {
		if (event.type === "session.created") {
			transport.sendJson({
				type: "session.update",
				session: { audio_format: {
					encoding: config.encoding,
					sample_rate: config.sampleRate
				} }
			});
			transport.markReady();
			return;
		}
		if (!transport.isReady() && event.type === "error") {
			transport.failConnect(new Error(readErrorDetail(event)));
			return;
		}
		switch (event.type) {
			case "transcription.text.delta":
				if (event.text) {
					partialText += event.text;
					config.onPartial?.(partialText);
				}
				return;
			case "transcription.segment":
				if (event.text) {
					config.onTranscript?.(event.text);
					partialText = "";
				}
				return;
			case "transcription.done":
				if (partialText.trim()) {
					config.onTranscript?.(partialText);
					partialText = "";
				}
				transport.closeNow();
				return;
			case "error":
				config.onError?.(new Error(readErrorDetail(event)));
				return;
			default: return;
		}
	};
	return createRealtimeTranscriptionWebSocketSession({
		providerId: "mistral",
		callbacks: config,
		url: () => toMistralRealtimeWsUrl(config),
		headers: { Authorization: `Bearer ${config.apiKey}` },
		connectTimeoutMs: MISTRAL_REALTIME_CONNECT_TIMEOUT_MS,
		closeTimeoutMs: MISTRAL_REALTIME_CLOSE_TIMEOUT_MS,
		maxReconnectAttempts: MISTRAL_REALTIME_MAX_RECONNECT_ATTEMPTS,
		reconnectDelayMs: MISTRAL_REALTIME_RECONNECT_DELAY_MS,
		maxQueuedBytes: MISTRAL_REALTIME_MAX_QUEUED_BYTES,
		connectTimeoutMessage: "Mistral realtime transcription connection timeout",
		reconnectLimitMessage: "Mistral realtime transcription reconnect limit reached",
		sendAudio: (audio, transport) => {
			transport.sendJson({
				type: "input_audio.append",
				audio: audio.toString("base64")
			});
		},
		onClose: (transport) => {
			transport.sendJson({ type: "input_audio.flush" });
			transport.sendJson({ type: "input_audio.end" });
		},
		onMessage: handleEvent
	});
}
function buildMistralRealtimeTranscriptionProvider() {
	return {
		id: "mistral",
		label: "Mistral Realtime Transcription",
		aliases: ["mistral-realtime", "voxtral-realtime"],
		defaultModel: MISTRAL_REALTIME_DEFAULT_MODEL,
		autoSelectOrder: 45,
		resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
		isConfigured: ({ providerConfig }) => Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.MISTRAL_API_KEY),
		createSession: (req) => {
			const config = normalizeProviderConfig(req.providerConfig);
			const apiKey = config.apiKey || process.env.MISTRAL_API_KEY;
			if (!apiKey) throw new Error("Mistral API key missing");
			return createMistralRealtimeTranscriptionSession({
				...req,
				apiKey,
				baseUrl: normalizeMistralRealtimeBaseUrl(config.baseUrl),
				model: config.model ?? MISTRAL_REALTIME_DEFAULT_MODEL,
				sampleRate: config.sampleRate ?? MISTRAL_REALTIME_DEFAULT_SAMPLE_RATE,
				encoding: config.encoding ?? MISTRAL_REALTIME_DEFAULT_ENCODING,
				targetStreamingDelayMs: config.targetStreamingDelayMs ?? MISTRAL_REALTIME_DEFAULT_DELAY_MS
			});
		}
	};
}
const testing = {
	normalizeProviderConfig,
	toMistralRealtimeWsUrl
};
//#endregion
export { testing as n, buildMistralRealtimeTranscriptionProvider as t };
