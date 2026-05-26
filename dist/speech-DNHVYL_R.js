import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { d as readProviderBinaryResponse, n as asObject, r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./provider-registry-mISFpr4F.js";
import "./directives-DiYOXJC0.js";
import "./secret-input-CWnTb0tw.js";
import "./provider-http-CYBE-CBM.js";
//#region src/tts/openai-compatible-speech-provider.ts
function normalizeResponseFormat(params) {
	const next = normalizeOptionalLowercaseString(params.value);
	if (!next) return;
	if (params.responseFormats.includes(next)) return next;
	throw new Error(`Invalid ${params.providerLabel} speech responseFormat: ${next}`);
}
function responseFormatToFileExtension(format) {
	return `.${format}`;
}
function trimTrailingBaseUrl(value, fallback) {
	return (normalizeOptionalString(value) ?? fallback).replace(/\/+$/u, "");
}
function normalizeBaseUrl(params) {
	const normalized = trimTrailingBaseUrl(params.value, params.fallback);
	if (params.policy?.kind !== "canonical") return normalized;
	const canonical = trimTrailingBaseUrl(params.fallback, params.fallback);
	return new Set([canonical, ...params.policy.aliases ?? []].map((entry) => trimTrailingBaseUrl(entry, canonical))).has(normalized) || !params.policy.allowCustom ? canonical : normalized;
}
function resolveProviderConfigRecord(rawConfig, providerConfigKey) {
	return asObject(asObject(rawConfig.providers)?.[providerConfigKey]) ?? asObject(rawConfig[providerConfigKey]);
}
function readModelProviderConfig(cfg, providerConfigKey) {
	return asObject(asObject(asObject(asObject(cfg)?.models)?.providers)?.[providerConfigKey]);
}
function readSpeechOverrides(overrides) {
	if (!overrides) return {};
	return {
		model: normalizeOptionalString(overrides.model ?? overrides.modelId),
		voice: normalizeOptionalString(overrides.voice ?? overrides.voiceId),
		speed: asFiniteNumber(overrides.speed)
	};
}
function parseDirectiveToken(ctx, providerConfigKey) {
	const compactProviderKey = providerConfigKey.replace(/[^a-z0-9]+/giu, "").toLowerCase();
	switch (ctx.key) {
		case "voice":
		case "voice_id":
		case "voiceid":
		case `${providerConfigKey}_voice`:
		case `${compactProviderKey}voice`:
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: { voice: ctx.value }
			};
		case "model":
		case "model_id":
		case "modelid":
		case `${providerConfigKey}_model`:
		case `${compactProviderKey}model`:
			if (!ctx.policy.allowModelId) return { handled: true };
			return {
				handled: true,
				overrides: { model: ctx.value }
			};
		default: return { handled: false };
	}
}
function buildExtraJsonBodyFields(config, fields) {
	const body = {};
	for (const field of fields ?? []) {
		const value = config[field.configKey];
		if (value != null) body[field.requestKey ?? field.configKey] = value;
	}
	return body;
}
function createOpenAiCompatibleSpeechProvider(options) {
	const providerConfigKey = options.configKey ?? options.id;
	const normalizeModel = options.normalizeModel ?? ((value, fallback) => normalizeOptionalString(value) ?? fallback);
	const readExtraConfig = options.readExtraConfig ?? (() => ({}));
	function normalizeConfig(rawConfig) {
		const raw = resolveProviderConfigRecord(rawConfig, providerConfigKey);
		return {
			apiKey: normalizeResolvedSecretInputString({
				value: raw?.apiKey,
				path: `messages.tts.providers.${providerConfigKey}.apiKey`
			}),
			baseUrl: normalizeOptionalString(raw?.baseUrl) == null ? void 0 : normalizeBaseUrl({
				value: raw?.baseUrl,
				fallback: options.defaultBaseUrl,
				policy: options.baseUrlPolicy
			}),
			model: normalizeModel(normalizeOptionalString(raw?.model ?? raw?.modelId), options.defaultModel),
			voice: normalizeOptionalString(raw?.voice ?? raw?.voiceId) ?? options.defaultVoice,
			speed: asFiniteNumber(raw?.speed),
			responseFormat: normalizeResponseFormat({
				providerLabel: options.label,
				responseFormats: options.responseFormats,
				value: raw?.responseFormat
			}),
			...readExtraConfig(raw)
		};
	}
	function readProviderConfig(config) {
		const normalized = normalizeConfig({});
		return {
			apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
			baseUrl: normalizeOptionalString(config.baseUrl) == null ? normalized.baseUrl : normalizeBaseUrl({
				value: config.baseUrl,
				fallback: options.defaultBaseUrl,
				policy: options.baseUrlPolicy
			}),
			model: normalizeModel(normalizeOptionalString(config.model ?? config.modelId), normalized.model),
			voice: normalizeOptionalString(config.voice ?? config.voiceId) ?? normalized.voice,
			speed: asFiniteNumber(config.speed) ?? normalized.speed,
			responseFormat: normalizeResponseFormat({
				providerLabel: options.label,
				responseFormats: options.responseFormats,
				value: config.responseFormat
			}) ?? normalized.responseFormat,
			...readExtraConfig(config)
		};
	}
	function resolveApiKey(params) {
		return params.providerConfig.apiKey ?? normalizeResolvedSecretInputString({
			value: readModelProviderConfig(params.cfg, providerConfigKey)?.apiKey,
			path: `models.providers.${providerConfigKey}.apiKey`
		}) ?? normalizeOptionalString(process.env[options.envKey]);
	}
	function resolveBaseUrl(params) {
		return normalizeBaseUrl({
			value: params.providerConfig.baseUrl ?? normalizeOptionalString(readModelProviderConfig(params.cfg, providerConfigKey)?.baseUrl),
			fallback: options.defaultBaseUrl,
			policy: options.baseUrlPolicy
		});
	}
	return {
		id: options.id,
		label: options.label,
		autoSelectOrder: options.autoSelectOrder,
		models: [...options.models],
		voices: [...options.voices],
		resolveConfig: ({ rawConfig }) => normalizeConfig(rawConfig),
		parseDirectiveToken: (ctx) => parseDirectiveToken(ctx, providerConfigKey),
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			const base = normalizeConfig(baseTtsConfig);
			const responseFormat = normalizeResponseFormat({
				providerLabel: options.label,
				responseFormats: options.responseFormats,
				value: talkProviderConfig.responseFormat
			});
			const next = { ...base };
			if (talkProviderConfig.apiKey !== void 0) next.apiKey = normalizeResolvedSecretInputString({
				value: talkProviderConfig.apiKey,
				path: `talk.providers.${providerConfigKey}.apiKey`
			});
			const baseUrl = normalizeOptionalString(talkProviderConfig.baseUrl);
			if (baseUrl !== void 0) next.baseUrl = normalizeBaseUrl({
				value: baseUrl,
				fallback: options.defaultBaseUrl,
				policy: options.baseUrlPolicy
			});
			const modelId = normalizeOptionalString(talkProviderConfig.modelId);
			if (modelId !== void 0) next.model = normalizeModel(modelId, options.defaultModel);
			const voiceId = normalizeOptionalString(talkProviderConfig.voiceId);
			if (voiceId !== void 0) next.voice = voiceId;
			const speed = asFiniteNumber(talkProviderConfig.speed);
			if (speed !== void 0) next.speed = speed;
			if (responseFormat !== void 0) next.responseFormat = responseFormat;
			return next;
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId ?? params.voice) == null ? {} : { voice: normalizeOptionalString(params.voiceId ?? params.voice) },
			...normalizeOptionalString(params.modelId ?? params.model) == null ? {} : { model: normalizeOptionalString(params.modelId ?? params.model) },
			...asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }
		}),
		listVoices: async () => options.voices.map((voice) => ({
			id: voice,
			name: voice
		})),
		isConfigured: ({ cfg, providerConfig }) => Boolean(resolveApiKey({
			cfg,
			providerConfig: readProviderConfig(providerConfig)
		})),
		synthesize: async (req) => {
			const config = readProviderConfig(req.providerConfig);
			const overrides = readSpeechOverrides(req.providerOverrides);
			const apiKey = resolveApiKey({
				cfg: req.cfg,
				providerConfig: config
			});
			if (!apiKey) throw new Error(options.missingApiKeyError ?? `${options.label} API key missing`);
			const baseUrl = resolveBaseUrl({
				cfg: req.cfg,
				providerConfig: config
			});
			const responseFormat = config.responseFormat ?? options.defaultResponseFormat;
			const speed = overrides.speed ?? config.speed;
			const { allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl,
				defaultBaseUrl: options.defaultBaseUrl,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					...options.extraHeaders
				},
				provider: options.id,
				capability: "audio",
				transport: "http"
			});
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/audio/speech`,
				headers,
				body: {
					model: normalizeModel(overrides.model ?? config.model, options.defaultModel),
					input: req.text,
					voice: overrides.voice ?? config.voice,
					response_format: responseFormat,
					...speed == null ? {} : { speed },
					...buildExtraJsonBodyFields(config, options.extraJsonBodyFields)
				},
				timeoutMs: req.timeoutMs,
				fetchFn: fetch,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, options.apiErrorLabel ?? `${options.label} TTS API error`);
				return {
					audioBuffer: Buffer.from(await readProviderBinaryResponse(response, options.apiErrorLabel ?? `${options.label} TTS API error`, "audio")),
					outputFormat: responseFormat,
					fileExtension: responseFormatToFileExtension(responseFormat),
					voiceCompatible: options.voiceCompatibleResponseFormats.includes(responseFormat)
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { createOpenAiCompatibleSpeechProvider as t };
