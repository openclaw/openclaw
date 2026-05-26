import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-BxqheYvy.js";
import { t as asFiniteNumber } from "./number-coercion-jbeDQtsd.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./secret-input-DlbCRffO.js";
import "./speech-BduO54XN.js";
import "./model-definitions-DmV6zJgC.js";
import { a as xaiTTS, i as normalizeXaiTtsBaseUrl, n as isValidXaiTtsVoice, r as normalizeXaiLanguageCode, t as XAI_TTS_VOICES } from "./tts-Ciw34ujt.js";
//#region extensions/xai/speech-provider.ts
const XAI_SPEECH_RESPONSE_FORMATS = [
	"mp3",
	"wav",
	"pcm",
	"mulaw",
	"alaw"
];
function normalizeXaiSpeechResponseFormat(value) {
	const next = normalizeLowercaseStringOrEmpty(value);
	if (!next) return;
	if (XAI_SPEECH_RESPONSE_FORMATS.some((format) => format === next)) return next;
	throw new Error(`Invalid xAI speech responseFormat: ${next}`);
}
function resolveSpeechResponseFormat(_target, configuredFormat) {
	if (configuredFormat) return configuredFormat;
	return "mp3";
}
function responseFormatToFileExtension(format) {
	switch (format) {
		case "wav": return ".wav";
		case "pcm": return ".pcm";
		case "mulaw": return ".mulaw";
		case "alaw": return ".alaw";
		default: return ".mp3";
	}
}
function normalizeXaiProviderConfig(rawConfig) {
	const xai = (rawConfig?.providers)?.xai ?? rawConfig?.xai ?? rawConfig;
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: xai?.apiKey,
			path: "messages.tts.providers.xai.apiKey"
		}),
		baseUrl: normalizeXaiTtsBaseUrl(normalizeOptionalString(xai?.baseUrl) ?? normalizeOptionalString(process.env.XAI_BASE_URL) ?? "https://api.x.ai/v1"),
		voiceId: normalizeOptionalString(xai?.voiceId ?? xai?.voice) ?? "eve",
		language: normalizeXaiLanguageCode(normalizeOptionalString(xai?.language ?? xai?.languageCode)),
		speed: asFiniteNumber(xai?.speed),
		responseFormat: normalizeXaiSpeechResponseFormat(xai?.responseFormat)
	};
}
function readXaiProviderConfig(config) {
	const normalized = normalizeXaiProviderConfig({});
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
		baseUrl: normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl,
		voiceId: normalizeOptionalString(config.voiceId ?? config.voice) ?? normalized.voiceId,
		language: normalizeXaiLanguageCode(normalizeOptionalString(config.language ?? config.languageCode)) ?? normalized.language,
		speed: asFiniteNumber(config.speed) ?? normalized.speed,
		responseFormat: normalizeXaiSpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat
	};
}
function readXaiOverrides(overrides) {
	if (!overrides) return {};
	return {
		voiceId: normalizeOptionalString(overrides.voiceId ?? overrides.voice),
		language: normalizeXaiLanguageCode(normalizeOptionalString(overrides.language)),
		speed: asFiniteNumber(overrides.speed)
	};
}
function parseDirectiveToken(ctx) {
	const providerConfig = ctx.providerConfig;
	const baseUrl = normalizeOptionalString(providerConfig?.baseUrl);
	switch (ctx.key) {
		case "voice":
		case "voice_id":
		case "voiceid":
		case "xai_voice":
		case "xaivoice":
			if (!ctx.policy.allowVoice) return { handled: true };
			if (!isValidXaiTtsVoice(ctx.value, baseUrl)) return {
				handled: true,
				warnings: [`invalid xAI voice "${ctx.value}"`]
			};
			return {
				handled: true,
				overrides: { voiceId: ctx.value }
			};
		default: return { handled: false };
	}
}
function buildXaiSpeechProvider() {
	return {
		id: "xai",
		label: "xAI",
		autoSelectOrder: 25,
		models: [],
		voices: XAI_TTS_VOICES,
		resolveConfig: ({ rawConfig }) => normalizeXaiProviderConfig(rawConfig),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			const base = normalizeXaiProviderConfig(baseTtsConfig);
			const responseFormat = normalizeXaiSpeechResponseFormat(talkProviderConfig.responseFormat);
			return {
				...base,
				...talkProviderConfig.apiKey === void 0 ? {} : { apiKey: normalizeResolvedSecretInputString({
					value: talkProviderConfig.apiKey,
					path: "talk.providers.xai.apiKey"
				}) },
				...normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl: normalizeXaiTtsBaseUrl(normalizeOptionalString(talkProviderConfig.baseUrl)) },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voiceId: normalizeOptionalString(talkProviderConfig.voiceId) },
				...normalizeXaiLanguageCode(normalizeOptionalString(talkProviderConfig.language ?? talkProviderConfig.languageCode)) == null ? {} : { language: normalizeXaiLanguageCode(normalizeOptionalString(talkProviderConfig.language ?? talkProviderConfig.languageCode)) },
				...asFiniteNumber(talkProviderConfig.speed) == null ? {} : { speed: asFiniteNumber(talkProviderConfig.speed) },
				...responseFormat == null ? {} : { responseFormat }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId ?? params.voice) == null ? {} : { voiceId: normalizeOptionalString(params.voiceId ?? params.voice) },
			...normalizeXaiLanguageCode(normalizeOptionalString(params.language ?? params.languageCode)) == null ? {} : { language: normalizeXaiLanguageCode(normalizeOptionalString(params.language ?? params.languageCode)) },
			...asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }
		}),
		listVoices: async () => XAI_TTS_VOICES.map((voice) => ({
			id: voice,
			name: voice
		})),
		isConfigured: ({ providerConfig }) => Boolean(readXaiProviderConfig(providerConfig).apiKey || process.env.XAI_API_KEY),
		synthesize: async (req) => {
			const config = readXaiProviderConfig(req.providerConfig);
			const overrides = readXaiOverrides(req.providerOverrides);
			const apiKey = config.apiKey || process.env.XAI_API_KEY;
			if (!apiKey) throw new Error("xAI API key missing");
			const responseFormat = resolveSpeechResponseFormat(req.target, config.responseFormat);
			return {
				audioBuffer: await xaiTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: overrides.voiceId ?? config.voiceId,
					language: overrides.language ?? config.language,
					speed: overrides.speed ?? config.speed,
					responseFormat,
					timeoutMs: req.timeoutMs
				}),
				outputFormat: responseFormat,
				fileExtension: responseFormatToFileExtension(responseFormat),
				voiceCompatible: false
			};
		},
		synthesizeTelephony: async (req) => {
			const config = readXaiProviderConfig(req.providerConfig);
			const overrides = readXaiOverrides(req.providerOverrides);
			const apiKey = config.apiKey || process.env.XAI_API_KEY;
			if (!apiKey) throw new Error("xAI API key missing");
			const outputFormat = "pcm";
			return {
				audioBuffer: await xaiTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: overrides.voiceId ?? config.voiceId,
					language: overrides.language ?? config.language,
					speed: overrides.speed ?? config.speed,
					responseFormat: outputFormat,
					timeoutMs: req.timeoutMs
				}),
				outputFormat,
				sampleRate: 24e3
			};
		}
	};
}
//#endregion
export { buildXaiSpeechProvider as t };
