import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { n as asObject } from "./provider-http-errors-C90BH-le.js";
import "./secret-input-CWnTb0tw.js";
import "./speech-core-DVjAqDEd.js";
import { c as inferAzureSpeechFileExtension, d as normalizeAzureSpeechBaseUrl, l as isAzureSpeechVoiceCompatible, o as azureSpeechTTS, r as DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT, u as listAzureSpeechVoices } from "./tts-DJ891qEF.js";
//#region extensions/azure-speech/speech-provider.ts
function readAzureSpeechEnvApiKey() {
	return normalizeOptionalString(process.env.AZURE_SPEECH_KEY) ?? normalizeOptionalString(process.env.AZURE_SPEECH_API_KEY) ?? normalizeOptionalString(process.env.SPEECH_KEY);
}
function readAzureSpeechEnvRegion() {
	return normalizeOptionalString(process.env.AZURE_SPEECH_REGION) ?? normalizeOptionalString(process.env.SPEECH_REGION);
}
function readAzureSpeechEnvEndpoint() {
	return normalizeOptionalString(process.env.AZURE_SPEECH_ENDPOINT);
}
function resolveAzureSpeechConfigRecord(rawConfig) {
	const providers = asObject(rawConfig.providers);
	return asObject(providers?.["azure-speech"]) ?? asObject(providers?.azure) ?? asObject(rawConfig["azure-speech"]) ?? asObject(rawConfig.azure);
}
function normalizeAzureSpeechProviderConfig(rawConfig) {
	const raw = resolveAzureSpeechConfigRecord(rawConfig);
	const region = normalizeOptionalString(raw?.region) ?? readAzureSpeechEnvRegion();
	const endpoint = normalizeOptionalString(raw?.endpoint) ?? readAzureSpeechEnvEndpoint();
	const baseUrl = normalizeAzureSpeechBaseUrl({
		baseUrl: normalizeOptionalString(raw?.baseUrl),
		endpoint,
		region
	});
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.azure-speech.apiKey"
		}),
		region,
		endpoint,
		baseUrl,
		voice: normalizeOptionalString(raw?.voice ?? raw?.voiceId) ?? "en-US-JennyNeural",
		lang: normalizeOptionalString(raw?.lang ?? raw?.languageCode) ?? "en-US",
		outputFormat: normalizeOptionalString(raw?.outputFormat) ?? "audio-24khz-48kbitrate-mono-mp3",
		voiceNoteOutputFormat: normalizeOptionalString(raw?.voiceNoteOutputFormat) ?? "ogg-24khz-16bit-mono-opus",
		timeoutMs: asFiniteNumber(raw?.timeoutMs)
	};
}
function readAzureSpeechProviderConfig(config) {
	const defaults = normalizeAzureSpeechProviderConfig({});
	const region = normalizeOptionalString(config.region) ?? defaults.region;
	const endpoint = normalizeOptionalString(config.endpoint) ?? defaults.endpoint;
	const baseUrl = normalizeAzureSpeechBaseUrl({
		baseUrl: normalizeOptionalString(config.baseUrl) ?? defaults.baseUrl,
		endpoint,
		region
	});
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? defaults.apiKey,
		region,
		endpoint,
		baseUrl,
		voice: normalizeOptionalString(config.voice ?? config.voiceId) ?? defaults.voice,
		lang: normalizeOptionalString(config.lang ?? config.languageCode) ?? defaults.lang,
		outputFormat: normalizeOptionalString(config.outputFormat) ?? defaults.outputFormat,
		voiceNoteOutputFormat: normalizeOptionalString(config.voiceNoteOutputFormat) ?? defaults.voiceNoteOutputFormat,
		timeoutMs: asFiniteNumber(config.timeoutMs) ?? defaults.timeoutMs
	};
}
function readAzureSpeechOverrides(overrides) {
	if (!overrides) return {};
	return {
		voice: normalizeOptionalString(overrides.voice ?? overrides.voiceId),
		lang: normalizeOptionalString(overrides.lang ?? overrides.languageCode),
		outputFormat: normalizeOptionalString(overrides.outputFormat)
	};
}
function parseDirectiveToken(ctx) {
	switch (ctx.key) {
		case "voice":
		case "voiceid":
		case "voice_id":
		case "azure_voice":
		case "azurevoice":
		case "azure_speech_voice":
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: {
					...ctx.currentOverrides,
					voice: ctx.value
				}
			};
		case "lang":
		case "language":
		case "language_code":
		case "languagecode":
		case "azure_lang":
		case "azure_language":
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			return {
				handled: true,
				overrides: {
					...ctx.currentOverrides,
					lang: ctx.value
				}
			};
		case "output_format":
		case "outputformat":
		case "azure_format":
		case "azure_output_format":
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			return {
				handled: true,
				overrides: {
					...ctx.currentOverrides,
					outputFormat: ctx.value
				}
			};
		default: return { handled: false };
	}
}
function resolveApiKey(config) {
	return config.apiKey ?? readAzureSpeechEnvApiKey();
}
function resolveTimeoutMs(config, timeoutMs) {
	return config.timeoutMs ?? timeoutMs;
}
function buildAzureSpeechProvider() {
	return {
		id: "azure-speech",
		label: "Azure Speech",
		aliases: ["azure"],
		autoSelectOrder: 30,
		resolveConfig: ({ rawConfig }) => normalizeAzureSpeechProviderConfig(rawConfig),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			const base = normalizeAzureSpeechProviderConfig(baseTtsConfig);
			const apiKey = talkProviderConfig.apiKey === void 0 ? void 0 : normalizeResolvedSecretInputString({
				value: talkProviderConfig.apiKey,
				path: "talk.providers.azure-speech.apiKey"
			});
			const region = normalizeOptionalString(talkProviderConfig.region);
			const endpoint = normalizeOptionalString(talkProviderConfig.endpoint ?? talkProviderConfig.baseUrl);
			const baseUrl = normalizeAzureSpeechBaseUrl({
				baseUrl: normalizeOptionalString(talkProviderConfig.baseUrl),
				endpoint,
				region: region ?? base.region
			});
			return {
				...base,
				...apiKey === void 0 ? {} : { apiKey },
				...region === void 0 ? {} : { region },
				...endpoint === void 0 ? {} : { endpoint },
				...baseUrl === void 0 ? {} : { baseUrl },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voice: normalizeOptionalString(talkProviderConfig.voiceId) },
				...normalizeOptionalString(talkProviderConfig.languageCode) == null ? {} : { lang: normalizeOptionalString(talkProviderConfig.languageCode) },
				...normalizeOptionalString(talkProviderConfig.outputFormat) == null ? {} : { outputFormat: normalizeOptionalString(talkProviderConfig.outputFormat) }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId) == null ? {} : { voice: normalizeOptionalString(params.voiceId) },
			...normalizeOptionalString(params.languageCode) == null ? {} : { lang: normalizeOptionalString(params.languageCode) },
			...normalizeOptionalString(params.outputFormat) == null ? {} : { outputFormat: normalizeOptionalString(params.outputFormat) }
		}),
		listVoices: async (req) => {
			const config = req.providerConfig ? readAzureSpeechProviderConfig(req.providerConfig) : void 0;
			const apiKey = req.apiKey ?? (config ? resolveApiKey(config) : readAzureSpeechEnvApiKey());
			if (!apiKey) throw new Error("Azure Speech API key missing");
			return listAzureSpeechVoices({
				apiKey,
				baseUrl: req.baseUrl ?? config?.baseUrl,
				endpoint: config?.endpoint,
				region: config?.region ?? readAzureSpeechEnvRegion(),
				timeoutMs: config?.timeoutMs
			});
		},
		isConfigured: ({ providerConfig }) => {
			const config = readAzureSpeechProviderConfig(providerConfig);
			return Boolean(resolveApiKey(config) && (config.baseUrl || config.region || config.endpoint));
		},
		synthesize: async (req) => {
			const config = readAzureSpeechProviderConfig(req.providerConfig);
			const overrides = readAzureSpeechOverrides(req.providerOverrides);
			const apiKey = resolveApiKey(config);
			if (!apiKey) throw new Error("Azure Speech API key missing");
			const outputFormat = overrides.outputFormat ?? (req.target === "voice-note" ? config.voiceNoteOutputFormat : config.outputFormat);
			return {
				audioBuffer: await azureSpeechTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					endpoint: config.endpoint,
					region: config.region,
					voice: overrides.voice ?? config.voice,
					lang: overrides.lang ?? config.lang,
					outputFormat,
					timeoutMs: resolveTimeoutMs(config, req.timeoutMs)
				}),
				outputFormat,
				fileExtension: inferAzureSpeechFileExtension(outputFormat),
				voiceCompatible: isAzureSpeechVoiceCompatible(outputFormat)
			};
		},
		synthesizeTelephony: async (req) => {
			const config = readAzureSpeechProviderConfig(req.providerConfig);
			const overrides = readAzureSpeechOverrides(req.providerOverrides);
			const apiKey = resolveApiKey(config);
			if (!apiKey) throw new Error("Azure Speech API key missing");
			return {
				audioBuffer: await azureSpeechTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					endpoint: config.endpoint,
					region: config.region,
					voice: overrides.voice ?? config.voice,
					lang: overrides.lang ?? config.lang,
					outputFormat: DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
					timeoutMs: resolveTimeoutMs(config, req.timeoutMs)
				}),
				outputFormat: DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT,
				sampleRate: 8e3
			};
		}
	};
}
//#endregion
export { buildAzureSpeechProvider as t };
