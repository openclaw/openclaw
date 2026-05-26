import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { g as transcodeAudioBufferToOpus } from "./media-services-CLFjOJQs.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { i as assertOkOrThrowProviderError, n as asObject } from "./provider-http-errors-C90BH-le.js";
import "./secret-input-CWnTb0tw.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./speech-core-DVjAqDEd.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/xiaomi/speech-provider.ts
const DEFAULT_XIAOMI_TTS_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_XIAOMI_TTS_MODEL = "mimo-v2.5-tts";
const DEFAULT_XIAOMI_TTS_VOICE = "mimo_default";
const DEFAULT_XIAOMI_TTS_FORMAT = "mp3";
const XIAOMI_TTS_MODELS = ["mimo-v2.5-tts", "mimo-v2-tts"];
const XIAOMI_TTS_VOICES = [
	"mimo_default",
	"default_zh",
	"default_en",
	"Mia",
	"Chloe",
	"Milo",
	"Dean"
];
const XIAOMI_TTS_FORMATS = ["mp3", "wav"];
function normalizeXiaomiTtsBaseUrl(baseUrl) {
	return (baseUrl?.trim() || DEFAULT_XIAOMI_TTS_BASE_URL).replace(/\/+$/, "");
}
function normalizeXiaomiTtsFormat(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	return XIAOMI_TTS_FORMATS.includes(normalized) ? normalized : void 0;
}
function resolveXiaomiTtsConfigRecord(rawConfig) {
	const providers = asObject(rawConfig.providers);
	return asObject(providers?.xiaomi) ?? asObject(providers?.mimo) ?? asObject(rawConfig.xiaomi);
}
function normalizeXiaomiTtsProviderConfig(rawConfig) {
	const raw = resolveXiaomiTtsConfigRecord(rawConfig);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.xiaomi.apiKey"
		}),
		baseUrl: normalizeXiaomiTtsBaseUrl(normalizeOptionalString(raw?.baseUrl) ?? normalizeOptionalString(process.env.XIAOMI_BASE_URL)),
		model: normalizeOptionalString(raw?.model) ?? normalizeOptionalString(process.env.XIAOMI_TTS_MODEL) ?? DEFAULT_XIAOMI_TTS_MODEL,
		voice: normalizeOptionalString(raw?.voice) ?? normalizeOptionalString(raw?.voiceId) ?? normalizeOptionalString(process.env.XIAOMI_TTS_VOICE) ?? DEFAULT_XIAOMI_TTS_VOICE,
		format: normalizeXiaomiTtsFormat(raw?.format) ?? normalizeXiaomiTtsFormat(process.env.XIAOMI_TTS_FORMAT) ?? DEFAULT_XIAOMI_TTS_FORMAT,
		style: normalizeOptionalString(raw?.style)
	};
}
function readXiaomiTtsProviderConfig(config) {
	const normalized = normalizeXiaomiTtsProviderConfig({});
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: config.apiKey,
			path: "messages.tts.providers.xiaomi.apiKey"
		}) ?? normalized.apiKey,
		baseUrl: normalizeXiaomiTtsBaseUrl(normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl),
		model: normalizeOptionalString(config.model) ?? normalized.model,
		voice: normalizeOptionalString(config.voice) ?? normalizeOptionalString(config.voiceId) ?? normalized.voice,
		format: normalizeXiaomiTtsFormat(config.format) ?? normalized.format,
		style: normalizeOptionalString(config.style) ?? normalized.style
	};
}
function readXiaomiTtsOverrides(overrides) {
	if (!overrides) return {};
	return {
		model: normalizeOptionalString(overrides.model),
		voice: normalizeOptionalString(overrides.voice) ?? normalizeOptionalString(overrides.voiceId),
		format: normalizeXiaomiTtsFormat(overrides.format),
		style: normalizeOptionalString(overrides.style)
	};
}
function parseDirectiveToken(ctx) {
	switch (ctx.key) {
		case "voice":
		case "voiceid":
		case "voice_id":
		case "mimo_voice":
		case "xiaomi_voice":
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: { voice: ctx.value }
			};
		case "model":
		case "mimo_model":
		case "xiaomi_model":
			if (!ctx.policy.allowModelId) return { handled: true };
			return {
				handled: true,
				overrides: { model: ctx.value }
			};
		case "style":
		case "mimo_style":
		case "xiaomi_style":
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			return {
				handled: true,
				overrides: { style: ctx.value }
			};
		case "format":
		case "responseformat":
		case "response_format": {
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			const format = normalizeXiaomiTtsFormat(ctx.value);
			if (!format) return {
				handled: true,
				warnings: [`invalid Xiaomi TTS format "${ctx.value}"`]
			};
			return {
				handled: true,
				overrides: { format }
			};
		}
		default: return { handled: false };
	}
}
function buildXiaomiTtsMessages(params) {
	const style = normalizeOptionalString(params.style);
	return [...style ? [{
		role: "user",
		content: style
	}] : [], {
		role: "assistant",
		content: params.text
	}];
}
function decodeXiaomiAudioData(body) {
	const root = asObject(body);
	const audioData = normalizeOptionalString(asObject(asObject(asObject((Array.isArray(root?.choices) ? root.choices : [])[0])?.message)?.audio)?.data);
	if (!audioData) throw new Error("Xiaomi TTS API returned no audio data");
	return Buffer.from(audioData, "base64");
}
async function xiaomiTTS(params) {
	const { text, apiKey, baseUrl, model, voice, format, style, timeoutMs } = params;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: `${baseUrl}/chat/completions`,
			init: {
				method: "POST",
				headers: {
					"api-key": apiKey,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					messages: buildXiaomiTtsMessages({
						text,
						style
					}),
					audio: {
						format,
						voice
					}
				}),
				signal: controller.signal
			},
			timeoutMs,
			policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
			auditContext: "xiaomi.tts"
		});
		try {
			await assertOkOrThrowProviderError(response, "Xiaomi TTS API error");
			return decodeXiaomiAudioData(await response.json());
		} finally {
			await release();
		}
	} finally {
		clearTimeout(timeout);
	}
}
function buildXiaomiSpeechProvider() {
	return {
		id: "xiaomi",
		label: "Xiaomi MiMo",
		aliases: ["mimo"],
		autoSelectOrder: 45,
		models: XIAOMI_TTS_MODELS,
		voices: XIAOMI_TTS_VOICES,
		resolveConfig: ({ rawConfig }) => normalizeXiaomiTtsProviderConfig(rawConfig),
		parseDirectiveToken,
		listVoices: async () => XIAOMI_TTS_VOICES.map((voice) => ({
			id: voice,
			name: voice
		})),
		isConfigured: ({ providerConfig }) => Boolean(readXiaomiTtsProviderConfig(providerConfig).apiKey || process.env.XIAOMI_API_KEY),
		synthesize: async (req) => {
			const config = readXiaomiTtsProviderConfig(req.providerConfig);
			const overrides = readXiaomiTtsOverrides(req.providerOverrides);
			const apiKey = config.apiKey || process.env.XIAOMI_API_KEY;
			if (!apiKey) throw new Error("Xiaomi API key missing");
			const outputFormat = overrides.format ?? config.format;
			const audioBuffer = await xiaomiTTS({
				text: req.text,
				apiKey,
				baseUrl: config.baseUrl,
				model: overrides.model ?? config.model,
				voice: overrides.voice ?? config.voice,
				format: outputFormat,
				style: overrides.style ?? config.style,
				timeoutMs: req.timeoutMs
			});
			if (req.target === "voice-note") return {
				audioBuffer: await transcodeAudioBufferToOpus({
					audioBuffer,
					inputExtension: outputFormat,
					tempPrefix: "tts-xiaomi-",
					timeoutMs: req.timeoutMs
				}),
				outputFormat: "opus",
				fileExtension: ".opus",
				voiceCompatible: true
			};
			return {
				audioBuffer,
				outputFormat,
				fileExtension: `.${outputFormat}`,
				voiceCompatible: false
			};
		}
	};
}
//#endregion
export { buildXiaomiSpeechProvider as t };
