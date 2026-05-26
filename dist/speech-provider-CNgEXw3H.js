import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { n as asObject } from "./provider-http-errors-C90BH-le.js";
import "./secret-input-CWnTb0tw.js";
import "./speech-core-DVjAqDEd.js";
import { a as listInworldVoices, i as inworldTTS, o as normalizeInworldBaseUrl, r as INWORLD_TTS_MODELS } from "./tts-D8WiOilm.js";
//#region extensions/inworld/speech-provider.ts
function normalizeInworldProviderConfig(rawConfig) {
	const raw = asObject(asObject(rawConfig.providers)?.inworld) ?? asObject(rawConfig.inworld);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.inworld.apiKey"
		}),
		baseUrl: normalizeInworldBaseUrl(normalizeOptionalString(raw?.baseUrl)),
		voiceId: normalizeOptionalString(raw?.voiceId) ?? "Sarah",
		modelId: normalizeOptionalString(raw?.modelId) ?? "inworld-tts-1.5-max",
		temperature: asFiniteNumber(raw?.temperature)
	};
}
function readInworldProviderConfig(config) {
	const defaults = normalizeInworldProviderConfig({});
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? defaults.apiKey,
		baseUrl: normalizeInworldBaseUrl(normalizeOptionalString(config.baseUrl) ?? defaults.baseUrl),
		voiceId: normalizeOptionalString(config.voiceId) ?? defaults.voiceId,
		modelId: normalizeOptionalString(config.modelId) ?? defaults.modelId,
		temperature: asFiniteNumber(config.temperature) ?? defaults.temperature
	};
}
function readInworldOverrides(overrides) {
	if (!overrides) return {};
	return {
		voiceId: normalizeOptionalString(overrides.voiceId ?? overrides.voice),
		modelId: normalizeOptionalString(overrides.modelId ?? overrides.model),
		temperature: asFiniteNumber(overrides.temperature)
	};
}
function parseDirectiveToken(ctx) {
	switch (ctx.key) {
		case "voice":
		case "voiceid":
		case "voice_id":
		case "inworld_voice":
		case "inworldvoice":
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: { voiceId: ctx.value }
			};
		case "model":
		case "modelid":
		case "model_id":
		case "inworld_model":
		case "inworldmodel":
			if (!ctx.policy.allowModelId) return { handled: true };
			return {
				handled: true,
				overrides: { modelId: ctx.value }
			};
		case "temperature": {
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			const temperature = Number(ctx.value);
			if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return {
				handled: true,
				warnings: [`invalid Inworld temperature "${ctx.value}"`]
			};
			return {
				handled: true,
				overrides: { temperature }
			};
		}
		default: return { handled: false };
	}
}
function buildInworldSpeechProvider() {
	return {
		id: "inworld",
		label: "Inworld",
		autoSelectOrder: 30,
		models: INWORLD_TTS_MODELS,
		resolveConfig: ({ rawConfig }) => normalizeInworldProviderConfig(rawConfig),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			const base = normalizeInworldProviderConfig(baseTtsConfig);
			const resolvedApiKey = talkProviderConfig.apiKey === void 0 ? void 0 : normalizeResolvedSecretInputString({
				value: talkProviderConfig.apiKey,
				path: "talk.providers.inworld.apiKey"
			});
			return {
				...base,
				...resolvedApiKey === void 0 ? {} : { apiKey: resolvedApiKey },
				...normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl: normalizeInworldBaseUrl(normalizeOptionalString(talkProviderConfig.baseUrl)) },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voiceId: normalizeOptionalString(talkProviderConfig.voiceId) },
				...normalizeOptionalString(talkProviderConfig.modelId) == null ? {} : { modelId: normalizeOptionalString(talkProviderConfig.modelId) },
				...asFiniteNumber(talkProviderConfig.temperature) == null ? {} : { temperature: asFiniteNumber(talkProviderConfig.temperature) }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId) == null ? {} : { voiceId: normalizeOptionalString(params.voiceId) },
			...normalizeOptionalString(params.modelId) == null ? {} : { modelId: normalizeOptionalString(params.modelId) },
			...asFiniteNumber(params.temperature) == null ? {} : { temperature: asFiniteNumber(params.temperature) }
		}),
		listVoices: async (req) => {
			const config = req.providerConfig ? readInworldProviderConfig(req.providerConfig) : void 0;
			const apiKey = req.apiKey || config?.apiKey || process.env.INWORLD_API_KEY;
			if (!apiKey) throw new Error("Inworld API key missing");
			return listInworldVoices({
				apiKey,
				baseUrl: req.baseUrl ?? config?.baseUrl
			});
		},
		isConfigured: ({ providerConfig }) => Boolean(readInworldProviderConfig(providerConfig).apiKey || process.env.INWORLD_API_KEY),
		synthesize: async (req) => {
			const config = readInworldProviderConfig(req.providerConfig);
			const overrides = readInworldOverrides(req.providerOverrides);
			const apiKey = config.apiKey || process.env.INWORLD_API_KEY;
			if (!apiKey) throw new Error("Inworld API key missing");
			const useOpus = req.target === "voice-note";
			const audioEncoding = useOpus ? "OGG_OPUS" : "MP3";
			return {
				audioBuffer: await inworldTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: overrides.voiceId ?? config.voiceId,
					modelId: overrides.modelId ?? config.modelId,
					audioEncoding,
					temperature: overrides.temperature ?? config.temperature,
					timeoutMs: req.timeoutMs
				}),
				outputFormat: audioEncoding.toLowerCase(),
				fileExtension: useOpus ? ".ogg" : ".mp3",
				voiceCompatible: useOpus
			};
		},
		synthesizeTelephony: async (req) => {
			const config = readInworldProviderConfig(req.providerConfig);
			const overrides = readInworldOverrides(req.providerOverrides);
			const apiKey = config.apiKey || process.env.INWORLD_API_KEY;
			if (!apiKey) throw new Error("Inworld API key missing");
			const sampleRate = 22050;
			return {
				audioBuffer: await inworldTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: overrides.voiceId ?? config.voiceId,
					modelId: overrides.modelId ?? config.modelId,
					audioEncoding: "PCM",
					sampleRateHertz: sampleRate,
					temperature: overrides.temperature ?? config.temperature,
					timeoutMs: req.timeoutMs
				}),
				outputFormat: "pcm",
				sampleRate
			};
		}
	};
}
//#endregion
export { buildInworldSpeechProvider as t };
