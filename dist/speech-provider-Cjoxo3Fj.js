import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { g as transcodeAudioBufferToOpus } from "./media-services-CLFjOJQs.js";
import { n as asObject } from "./provider-http-errors-C90BH-le.js";
import { i as isProviderAuthProfileConfigured, s as resolveProviderAuthProfileApiKey } from "./provider-auth-BtRKd5us.js";
import "./secret-input-CWnTb0tw.js";
import "./media-runtime-BheBFFxc.js";
import "./speech-core-DVjAqDEd.js";
import { a as normalizeMinimaxTtsBaseUrl, i as minimaxTTS, n as MINIMAX_TTS_MODELS, r as MINIMAX_TTS_VOICES } from "./tts-2q0arrBc.js";
//#region extensions/minimax/speech-provider.ts
const MINIMAX_PORTAL_PROVIDER_ID = "minimax-portal";
const MINIMAX_TOKEN_PLAN_ENV_VARS = [
	"MINIMAX_OAUTH_TOKEN",
	"MINIMAX_CODE_PLAN_KEY",
	"MINIMAX_CODING_API_KEY"
];
function resolveConfiguredPortalTtsBaseUrl(cfg) {
	const portalBaseUrl = normalizeOptionalString(asObject(asObject(asObject(cfg?.models)?.providers)?.[MINIMAX_PORTAL_PROVIDER_ID])?.baseUrl);
	return portalBaseUrl ? normalizeMinimaxTtsBaseUrl(portalBaseUrl) : void 0;
}
function resolveMinimaxTokenPlanEnvKey() {
	for (const envVar of MINIMAX_TOKEN_PLAN_ENV_VARS) {
		const value = normalizeOptionalString(process.env[envVar]);
		if (value) return value;
	}
}
async function resolveMinimaxPortalProfileToken(cfg) {
	return await resolveProviderAuthProfileApiKey({
		cfg,
		provider: MINIMAX_PORTAL_PROVIDER_ID
	});
}
async function resolveMinimaxTtsApiKey(params) {
	return params.configApiKey ?? await resolveMinimaxPortalProfileToken(params.cfg) ?? resolveMinimaxTokenPlanEnvKey() ?? normalizeOptionalString(process.env.MINIMAX_API_KEY);
}
function normalizeMinimaxProviderConfig(rawConfig, cfg) {
	const raw = asObject(asObject(rawConfig.providers)?.minimax) ?? asObject(rawConfig.minimax);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.minimax.apiKey"
		}),
		baseUrl: normalizeMinimaxTtsBaseUrl(normalizeOptionalString(raw?.baseUrl) ?? normalizeOptionalString(process.env.MINIMAX_API_HOST) ?? resolveConfiguredPortalTtsBaseUrl(cfg) ?? "https://api.minimax.io"),
		model: normalizeOptionalString(raw?.model) ?? normalizeOptionalString(process.env.MINIMAX_TTS_MODEL) ?? "speech-2.8-hd",
		voiceId: normalizeOptionalString(raw?.voiceId) ?? normalizeOptionalString(process.env.MINIMAX_TTS_VOICE_ID) ?? "English_expressive_narrator",
		speed: asFiniteNumber(raw?.speed),
		vol: asFiniteNumber(raw?.vol),
		pitch: asFiniteNumber(raw?.pitch)
	};
}
function readMinimaxProviderConfig(config, cfg) {
	const normalized = normalizeMinimaxProviderConfig({}, cfg);
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
		baseUrl: normalizeMinimaxTtsBaseUrl(normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl),
		model: normalizeOptionalString(config.model) ?? normalized.model,
		voiceId: normalizeOptionalString(config.voiceId) ?? normalized.voiceId,
		speed: asFiniteNumber(config.speed) ?? normalized.speed,
		vol: asFiniteNumber(config.vol) ?? normalized.vol,
		pitch: asFiniteNumber(config.pitch) ?? normalized.pitch
	};
}
function readMinimaxOverrides(overrides) {
	if (!overrides) return {};
	return {
		model: normalizeOptionalString(overrides.model),
		voiceId: normalizeOptionalString(overrides.voiceId),
		speed: asFiniteNumber(overrides.speed),
		vol: asFiniteNumber(overrides.vol),
		pitch: asFiniteNumber(overrides.pitch)
	};
}
function parseDirectiveToken(ctx) {
	switch (ctx.key) {
		case "voice":
		case "voiceid":
		case "voice_id":
		case "minimax_voice":
		case "minimaxvoice":
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: { voiceId: ctx.value }
			};
		case "model":
		case "minimax_model":
		case "minimaxmodel":
			if (!ctx.policy.allowModelId) return { handled: true };
			return {
				handled: true,
				overrides: { model: ctx.value }
			};
		case "speed": {
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			const speed = Number(ctx.value);
			if (!Number.isFinite(speed) || speed < .5 || speed > 2) return {
				handled: true,
				warnings: [`invalid MiniMax speed "${ctx.value}" (0.5-2.0)`]
			};
			return {
				handled: true,
				overrides: { speed }
			};
		}
		case "vol":
		case "volume": {
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			const vol = Number(ctx.value);
			if (!Number.isFinite(vol) || vol <= 0 || vol > 10) return {
				handled: true,
				warnings: [`invalid MiniMax volume "${ctx.value}" (0-10, exclusive)`]
			};
			return {
				handled: true,
				overrides: { vol }
			};
		}
		case "pitch": {
			if (!ctx.policy.allowVoiceSettings) return { handled: true };
			const pitch = Number(ctx.value);
			if (!Number.isFinite(pitch) || pitch < -12 || pitch > 12) return {
				handled: true,
				warnings: [`invalid MiniMax pitch "${ctx.value}" (-12 to 12)`]
			};
			return {
				handled: true,
				overrides: { pitch }
			};
		}
		default: return { handled: false };
	}
}
function buildMinimaxSpeechProvider() {
	return {
		id: "minimax",
		label: "MiniMax",
		autoSelectOrder: 40,
		models: MINIMAX_TTS_MODELS,
		voices: MINIMAX_TTS_VOICES,
		resolveConfig: ({ rawConfig, cfg }) => normalizeMinimaxProviderConfig(rawConfig, cfg),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			return {
				...normalizeMinimaxProviderConfig(baseTtsConfig),
				...talkProviderConfig.apiKey === void 0 ? {} : { apiKey: normalizeResolvedSecretInputString({
					value: talkProviderConfig.apiKey,
					path: "talk.providers.minimax.apiKey"
				}) },
				...normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl: normalizeMinimaxTtsBaseUrl(normalizeOptionalString(talkProviderConfig.baseUrl)) },
				...normalizeOptionalString(talkProviderConfig.modelId) == null ? {} : { model: normalizeOptionalString(talkProviderConfig.modelId) },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voiceId: normalizeOptionalString(talkProviderConfig.voiceId) },
				...asFiniteNumber(talkProviderConfig.speed) == null ? {} : { speed: asFiniteNumber(talkProviderConfig.speed) },
				...asFiniteNumber(talkProviderConfig.vol) == null ? {} : { vol: asFiniteNumber(talkProviderConfig.vol) },
				...asFiniteNumber(talkProviderConfig.pitch) == null ? {} : { pitch: asFiniteNumber(talkProviderConfig.pitch) }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId) == null ? {} : { voiceId: normalizeOptionalString(params.voiceId) },
			...normalizeOptionalString(params.modelId) == null ? {} : { model: normalizeOptionalString(params.modelId) },
			...asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) },
			...asFiniteNumber(params.vol) == null ? {} : { vol: asFiniteNumber(params.vol) },
			...asFiniteNumber(params.pitch) == null ? {} : { pitch: asFiniteNumber(params.pitch) }
		}),
		listVoices: async () => MINIMAX_TTS_VOICES.map((voice) => ({
			id: voice,
			name: voice
		})),
		isConfigured: ({ cfg, providerConfig }) => Boolean(readMinimaxProviderConfig(providerConfig, cfg).apiKey || isProviderAuthProfileConfigured({
			cfg,
			provider: MINIMAX_PORTAL_PROVIDER_ID
		}) || resolveMinimaxTokenPlanEnvKey() || process.env.MINIMAX_API_KEY),
		synthesize: async (req) => {
			const config = readMinimaxProviderConfig(req.providerConfig, req.cfg);
			const overrides = readMinimaxOverrides(req.providerOverrides);
			const apiKey = await resolveMinimaxTtsApiKey({
				cfg: req.cfg,
				configApiKey: config.apiKey
			});
			if (!apiKey) throw new Error("MiniMax TTS auth missing");
			const audioBuffer = await minimaxTTS({
				text: req.text,
				apiKey,
				baseUrl: config.baseUrl,
				model: overrides.model ?? config.model,
				voiceId: overrides.voiceId ?? config.voiceId,
				speed: overrides.speed ?? config.speed,
				vol: overrides.vol ?? config.vol,
				pitch: overrides.pitch ?? config.pitch,
				timeoutMs: req.timeoutMs
			});
			if (req.target === "voice-note") return {
				audioBuffer: await transcodeAudioBufferToOpus({
					audioBuffer,
					inputExtension: "mp3",
					tempPrefix: "tts-minimax-",
					timeoutMs: req.timeoutMs
				}),
				outputFormat: "opus",
				fileExtension: ".opus",
				voiceCompatible: true
			};
			return {
				audioBuffer,
				outputFormat: "mp3",
				fileExtension: ".mp3",
				voiceCompatible: false
			};
		}
	};
}
//#endregion
export { buildMinimaxSpeechProvider as t };
