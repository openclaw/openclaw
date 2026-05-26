import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { i as assertOkOrThrowProviderError, n as asObject, t as asBoolean } from "./provider-http-errors-C90BH-le.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { i as requireInRange, n as normalizeLanguageCode, r as normalizeSeed, t as normalizeApplyTextNormalization } from "./tts-provider-helpers-Ci4Z-bAw.js";
import "./provider-http-CYBE-CBM.js";
import "./speech-DNHVYL_R.js";
import { n as isValidElevenLabsVoiceId, r as normalizeElevenLabsBaseUrl } from "./shared-B7utk7gS.js";
import { r as resolveElevenLabsApiKeyWithProfileFallback } from "./config-compat-DiWqejlh.js";
import "./config-api-BQudFZMq.js";
import { n as elevenLabsTTSStream, t as elevenLabsTTS } from "./tts-yMoaz9vP.js";
//#region extensions/elevenlabs/speech-provider.ts
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
	stability: .5,
	similarityBoost: .75,
	style: 0,
	useSpeakerBoost: true,
	speed: 1
};
const ELEVENLABS_TTS_MODELS = [
	"eleven_v3",
	"eleven_multilingual_v2",
	"eleven_turbo_v2_5",
	"eleven_monolingual_v1"
];
function parseBooleanValue(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if ([
		"true",
		"1",
		"yes",
		"on"
	].includes(normalized)) return true;
	if ([
		"false",
		"0",
		"no",
		"off"
	].includes(normalized)) return false;
}
function parseNumberValue(value) {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
const isValidVoiceId = isValidElevenLabsVoiceId;
function normalizeElevenLabsProviderConfig(rawConfig) {
	const raw = asObject(asObject(rawConfig.providers)?.elevenlabs) ?? asObject(rawConfig.elevenlabs);
	const rawVoiceSettings = asObject(raw?.voiceSettings);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.elevenlabs.apiKey"
		}),
		baseUrl: normalizeElevenLabsBaseUrl(normalizeOptionalString(raw?.baseUrl)),
		voiceId: normalizeOptionalString(raw?.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID,
		modelId: normalizeOptionalString(raw?.modelId) ?? DEFAULT_ELEVENLABS_MODEL_ID,
		seed: asFiniteNumber(raw?.seed),
		applyTextNormalization: normalizeOptionalString(raw?.applyTextNormalization),
		languageCode: normalizeOptionalString(raw?.languageCode),
		voiceSettings: {
			stability: asFiniteNumber(rawVoiceSettings?.stability) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
			similarityBoost: asFiniteNumber(rawVoiceSettings?.similarityBoost) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
			style: asFiniteNumber(rawVoiceSettings?.style) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
			useSpeakerBoost: asBoolean(rawVoiceSettings?.useSpeakerBoost) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
			speed: asFiniteNumber(rawVoiceSettings?.speed) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed
		}
	};
}
function readElevenLabsProviderConfig(config) {
	const defaults = normalizeElevenLabsProviderConfig({});
	const voiceSettings = asObject(config.voiceSettings);
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? defaults.apiKey,
		baseUrl: normalizeElevenLabsBaseUrl(normalizeOptionalString(config.baseUrl) ?? defaults.baseUrl),
		voiceId: normalizeOptionalString(config.voiceId) ?? defaults.voiceId,
		modelId: normalizeOptionalString(config.modelId) ?? defaults.modelId,
		seed: asFiniteNumber(config.seed) ?? defaults.seed,
		applyTextNormalization: normalizeOptionalString(config.applyTextNormalization) ?? defaults.applyTextNormalization,
		languageCode: normalizeOptionalString(config.languageCode) ?? defaults.languageCode,
		voiceSettings: {
			stability: asFiniteNumber(voiceSettings?.stability) ?? defaults.voiceSettings.stability,
			similarityBoost: asFiniteNumber(voiceSettings?.similarityBoost) ?? defaults.voiceSettings.similarityBoost,
			style: asFiniteNumber(voiceSettings?.style) ?? defaults.voiceSettings.style,
			useSpeakerBoost: asBoolean(voiceSettings?.useSpeakerBoost) ?? defaults.voiceSettings.useSpeakerBoost,
			speed: asFiniteNumber(voiceSettings?.speed) ?? defaults.voiceSettings.speed
		}
	};
}
function mergeVoiceSettingsOverride(ctx, next) {
	return {
		...ctx.currentOverrides,
		voiceSettings: {
			...asObject(ctx.currentOverrides?.voiceSettings),
			...next
		}
	};
}
function resolveVoiceSettingsOverride(base, overrides) {
	const voiceSettings = asObject(overrides);
	return {
		...base,
		...asFiniteNumber(voiceSettings?.stability) == null ? {} : { stability: asFiniteNumber(voiceSettings?.stability) },
		...asFiniteNumber(voiceSettings?.similarityBoost) == null ? {} : { similarityBoost: asFiniteNumber(voiceSettings?.similarityBoost) },
		...asFiniteNumber(voiceSettings?.style) == null ? {} : { style: asFiniteNumber(voiceSettings?.style) },
		...asBoolean(voiceSettings?.useSpeakerBoost) == null ? {} : { useSpeakerBoost: asBoolean(voiceSettings?.useSpeakerBoost) },
		...asFiniteNumber(voiceSettings?.speed) == null ? {} : { speed: asFiniteNumber(voiceSettings?.speed) }
	};
}
function parseDirectiveToken(ctx) {
	try {
		switch (ctx.key) {
			case "voiceid":
			case "voice_id":
			case "elevenlabs_voice":
			case "elevenlabsvoice":
				if (!ctx.policy.allowVoice) return { handled: true };
				if (!isValidElevenLabsVoiceId(ctx.value)) return {
					handled: true,
					warnings: [`invalid ElevenLabs voiceId "${ctx.value}"`]
				};
				return {
					handled: true,
					overrides: {
						...ctx.currentOverrides,
						voiceId: ctx.value
					}
				};
			case "model":
			case "modelid":
			case "model_id":
			case "elevenlabs_model":
			case "elevenlabsmodel":
				if (!ctx.policy.allowModelId) return { handled: true };
				return {
					handled: true,
					overrides: {
						...ctx.currentOverrides,
						modelId: ctx.value
					}
				};
			case "stability": {
				if (!ctx.policy.allowVoiceSettings) return { handled: true };
				const value = parseNumberValue(ctx.value);
				if (value == null) return {
					handled: true,
					warnings: ["invalid stability value"]
				};
				requireInRange(value, 0, 1, "stability");
				return {
					handled: true,
					overrides: mergeVoiceSettingsOverride(ctx, { stability: value })
				};
			}
			case "similarity":
			case "similarityboost":
			case "similarity_boost": {
				if (!ctx.policy.allowVoiceSettings) return { handled: true };
				const value = parseNumberValue(ctx.value);
				if (value == null) return {
					handled: true,
					warnings: ["invalid similarityBoost value"]
				};
				requireInRange(value, 0, 1, "similarityBoost");
				return {
					handled: true,
					overrides: mergeVoiceSettingsOverride(ctx, { similarityBoost: value })
				};
			}
			case "style": {
				if (!ctx.policy.allowVoiceSettings) return { handled: true };
				const value = parseNumberValue(ctx.value);
				if (value == null) return {
					handled: true,
					warnings: ["invalid style value"]
				};
				requireInRange(value, 0, 1, "style");
				return {
					handled: true,
					overrides: mergeVoiceSettingsOverride(ctx, { style: value })
				};
			}
			case "speed": {
				if (!ctx.policy.allowVoiceSettings) return { handled: true };
				const value = parseNumberValue(ctx.value);
				if (value == null) return {
					handled: true,
					warnings: ["invalid speed value"]
				};
				requireInRange(value, .5, 2, "speed");
				return {
					handled: true,
					overrides: mergeVoiceSettingsOverride(ctx, { speed: value })
				};
			}
			case "speakerboost":
			case "speaker_boost":
			case "usespeakerboost":
			case "use_speaker_boost": {
				if (!ctx.policy.allowVoiceSettings) return { handled: true };
				const value = parseBooleanValue(ctx.value);
				if (value == null) return {
					handled: true,
					warnings: ["invalid useSpeakerBoost value"]
				};
				return {
					handled: true,
					overrides: mergeVoiceSettingsOverride(ctx, { useSpeakerBoost: value })
				};
			}
			case "normalize":
			case "applytextnormalization":
			case "apply_text_normalization":
				if (!ctx.policy.allowNormalization) return { handled: true };
				return {
					handled: true,
					overrides: {
						...ctx.currentOverrides,
						applyTextNormalization: normalizeApplyTextNormalization(ctx.value)
					}
				};
			case "language":
			case "languagecode":
			case "language_code":
				if (!ctx.policy.allowNormalization) return { handled: true };
				return {
					handled: true,
					overrides: {
						...ctx.currentOverrides,
						languageCode: normalizeLanguageCode(ctx.value)
					}
				};
			case "seed":
				if (!ctx.policy.allowSeed) return { handled: true };
				return {
					handled: true,
					overrides: {
						...ctx.currentOverrides,
						seed: normalizeSeed(Number.parseInt(ctx.value, 10))
					}
				};
			default: return { handled: false };
		}
	} catch (error) {
		return {
			handled: true,
			warnings: [formatErrorMessage(error)]
		};
	}
}
async function listElevenLabsVoices(params) {
	const normalizedBaseUrl = normalizeElevenLabsBaseUrl(params.baseUrl);
	const { response, release } = await fetchWithSsrFGuard({
		url: `${normalizedBaseUrl}/v1/voices`,
		init: { headers: { "xi-api-key": params.apiKey } },
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
		auditContext: "elevenlabs.voices"
	});
	try {
		await assertOkOrThrowProviderError(response, "ElevenLabs voices API error");
		const json = await response.json();
		return Array.isArray(json.voices) ? json.voices.map((voice) => ({
			id: voice.voice_id?.trim() ?? "",
			name: normalizeOptionalString(voice.name),
			category: normalizeOptionalString(voice.category),
			description: normalizeOptionalString(voice.description)
		})).filter((voice) => voice.id.length > 0) : [];
	} finally {
		await release();
	}
}
function buildElevenLabsSpeechProvider() {
	return {
		id: "elevenlabs",
		label: "ElevenLabs",
		autoSelectOrder: 20,
		models: ELEVENLABS_TTS_MODELS,
		resolveConfig: ({ rawConfig }) => normalizeElevenLabsProviderConfig(rawConfig),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			const base = normalizeElevenLabsProviderConfig(baseTtsConfig);
			const talkVoiceSettings = asObject(talkProviderConfig.voiceSettings);
			const resolvedTalkApiKey = talkProviderConfig.apiKey === void 0 ? resolveElevenLabsApiKeyWithProfileFallback() ?? void 0 : normalizeResolvedSecretInputString({
				value: talkProviderConfig.apiKey,
				path: "talk.providers.elevenlabs.apiKey"
			});
			return {
				...base,
				...resolvedTalkApiKey === void 0 ? {} : { apiKey: resolvedTalkApiKey },
				...normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl: normalizeElevenLabsBaseUrl(normalizeOptionalString(talkProviderConfig.baseUrl)) },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voiceId: normalizeOptionalString(talkProviderConfig.voiceId) },
				...normalizeOptionalString(talkProviderConfig.modelId) == null ? {} : { modelId: normalizeOptionalString(talkProviderConfig.modelId) },
				...asFiniteNumber(talkProviderConfig.seed) == null ? {} : { seed: asFiniteNumber(talkProviderConfig.seed) },
				...normalizeOptionalString(talkProviderConfig.applyTextNormalization) == null ? {} : { applyTextNormalization: normalizeApplyTextNormalization(normalizeOptionalString(talkProviderConfig.applyTextNormalization)) },
				...normalizeOptionalString(talkProviderConfig.languageCode) == null ? {} : { languageCode: normalizeLanguageCode(normalizeOptionalString(talkProviderConfig.languageCode)) },
				voiceSettings: {
					...base.voiceSettings,
					...asFiniteNumber(talkVoiceSettings?.stability) == null ? {} : { stability: asFiniteNumber(talkVoiceSettings?.stability) },
					...asFiniteNumber(talkVoiceSettings?.similarityBoost) == null ? {} : { similarityBoost: asFiniteNumber(talkVoiceSettings?.similarityBoost) },
					...asFiniteNumber(talkVoiceSettings?.style) == null ? {} : { style: asFiniteNumber(talkVoiceSettings?.style) },
					...asBoolean(talkVoiceSettings?.useSpeakerBoost) == null ? {} : { useSpeakerBoost: asBoolean(talkVoiceSettings?.useSpeakerBoost) },
					...asFiniteNumber(talkVoiceSettings?.speed) == null ? {} : { speed: asFiniteNumber(talkVoiceSettings?.speed) }
				}
			};
		},
		resolveTalkOverrides: ({ params }) => {
			const normalize = normalizeOptionalString(params.normalize);
			const language = normalizeLowercaseStringOrEmpty(normalizeOptionalString(params.language));
			const latencyTier = asFiniteNumber(params.latencyTier);
			const voiceSettings = {
				...asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) },
				...asFiniteNumber(params.stability) == null ? {} : { stability: asFiniteNumber(params.stability) },
				...asFiniteNumber(params.similarity) == null ? {} : { similarityBoost: asFiniteNumber(params.similarity) },
				...asFiniteNumber(params.style) == null ? {} : { style: asFiniteNumber(params.style) },
				...asBoolean(params.speakerBoost) == null ? {} : { useSpeakerBoost: asBoolean(params.speakerBoost) }
			};
			return {
				...normalizeOptionalString(params.voiceId) == null ? {} : { voiceId: normalizeOptionalString(params.voiceId) },
				...normalizeOptionalString(params.modelId) == null ? {} : { modelId: normalizeOptionalString(params.modelId) },
				...normalizeOptionalString(params.outputFormat) == null ? {} : { outputFormat: normalizeOptionalString(params.outputFormat) },
				...asFiniteNumber(params.seed) == null ? {} : { seed: asFiniteNumber(params.seed) },
				...normalize == null ? {} : { applyTextNormalization: normalizeApplyTextNormalization(normalize) },
				...language == null ? {} : { languageCode: normalizeLanguageCode(language) },
				...latencyTier == null ? {} : { latencyTier },
				...Object.keys(voiceSettings).length === 0 ? {} : { voiceSettings }
			};
		},
		listVoices: async (req) => {
			const config = req.providerConfig ? readElevenLabsProviderConfig(req.providerConfig) : void 0;
			const apiKey = req.apiKey || config?.apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY;
			if (!apiKey) throw new Error("ElevenLabs API key missing");
			return listElevenLabsVoices({
				apiKey,
				baseUrl: req.baseUrl ?? config?.baseUrl
			});
		},
		isConfigured: ({ providerConfig }) => Boolean(readElevenLabsProviderConfig(providerConfig).apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY),
		synthesize: async (req) => {
			const config = readElevenLabsProviderConfig(req.providerConfig);
			const overrides = req.providerOverrides ?? {};
			const apiKey = config.apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY;
			if (!apiKey) throw new Error("ElevenLabs API key missing");
			const outputFormat = normalizeOptionalString(overrides.outputFormat) ?? (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
			const latencyTier = asFiniteNumber(overrides.latencyTier);
			return {
				audioBuffer: await elevenLabsTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: normalizeOptionalString(overrides.voiceId) ?? config.voiceId,
					modelId: normalizeOptionalString(overrides.modelId) ?? config.modelId,
					outputFormat,
					seed: asFiniteNumber(overrides.seed) ?? config.seed,
					applyTextNormalization: normalizeOptionalString(overrides.applyTextNormalization) ?? config.applyTextNormalization,
					languageCode: normalizeOptionalString(overrides.languageCode) ?? config.languageCode,
					latencyTier,
					voiceSettings: resolveVoiceSettingsOverride(config.voiceSettings, overrides.voiceSettings),
					timeoutMs: req.timeoutMs
				}),
				outputFormat,
				fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
				voiceCompatible: req.target === "voice-note"
			};
		},
		streamSynthesize: async (req) => {
			const config = readElevenLabsProviderConfig(req.providerConfig);
			const overrides = req.providerOverrides ?? {};
			const apiKey = config.apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY;
			if (!apiKey) throw new Error("ElevenLabs API key missing");
			const outputFormat = normalizeOptionalString(overrides.outputFormat) ?? (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
			const latencyTier = asFiniteNumber(overrides.latencyTier);
			const stream = await elevenLabsTTSStream({
				text: req.text,
				apiKey,
				baseUrl: config.baseUrl,
				voiceId: normalizeOptionalString(overrides.voiceId) ?? config.voiceId,
				modelId: normalizeOptionalString(overrides.modelId) ?? config.modelId,
				outputFormat,
				seed: asFiniteNumber(overrides.seed) ?? config.seed,
				applyTextNormalization: normalizeOptionalString(overrides.applyTextNormalization) ?? config.applyTextNormalization,
				languageCode: normalizeOptionalString(overrides.languageCode) ?? config.languageCode,
				latencyTier,
				voiceSettings: resolveVoiceSettingsOverride(config.voiceSettings, overrides.voiceSettings),
				timeoutMs: req.timeoutMs
			});
			return {
				audioStream: stream.audioStream,
				outputFormat,
				fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
				voiceCompatible: req.target === "voice-note",
				release: stream.release
			};
		},
		synthesizeTelephony: async (req) => {
			const config = readElevenLabsProviderConfig(req.providerConfig);
			const overrides = req.providerOverrides ?? {};
			const apiKey = config.apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY;
			if (!apiKey) throw new Error("ElevenLabs API key missing");
			const outputFormat = "pcm_22050";
			return {
				audioBuffer: await elevenLabsTTS({
					text: req.text,
					apiKey,
					baseUrl: config.baseUrl,
					voiceId: normalizeOptionalString(overrides.voiceId) ?? config.voiceId,
					modelId: normalizeOptionalString(overrides.modelId) ?? config.modelId,
					outputFormat,
					seed: asFiniteNumber(overrides.seed) ?? config.seed,
					applyTextNormalization: normalizeOptionalString(overrides.applyTextNormalization) ?? config.applyTextNormalization,
					languageCode: normalizeOptionalString(overrides.languageCode) ?? config.languageCode,
					voiceSettings: resolveVoiceSettingsOverride(config.voiceSettings, overrides.voiceSettings),
					timeoutMs: req.timeoutMs
				}),
				outputFormat,
				sampleRate: 22050
			};
		}
	};
}
//#endregion
export { isValidVoiceId as n, buildElevenLabsSpeechProvider as t };
