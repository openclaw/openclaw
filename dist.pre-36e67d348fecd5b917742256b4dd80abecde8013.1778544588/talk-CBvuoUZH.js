import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord } from "./utils-D5swhEXt.js";
import { o as coerceSecretRef } from "./types.secrets-CL51SR4g.js";
//#region src/config/talk.ts
function normalizeTalkSecretInput(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : void 0;
	}
	return coerceSecretRef(value) ?? void 0;
}
function normalizeSilenceTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return;
	return value;
}
function buildLegacyTalkProviderCompat(value) {
	const provider = {};
	for (const key of [
		"voiceId",
		"voiceAliases",
		"modelId",
		"outputFormat"
	]) if (value[key] !== void 0) provider[key] = value[key];
	const apiKey = normalizeTalkSecretInput(value.apiKey);
	if (apiKey !== void 0) provider.apiKey = apiKey;
	return Object.keys(provider).length > 0 ? provider : void 0;
}
function normalizeTalkProviderConfig(value) {
	if (!isRecord(value)) return;
	const provider = {};
	for (const [key, raw] of Object.entries(value)) {
		if (raw === void 0) continue;
		if (key === "apiKey") {
			const normalized = normalizeTalkSecretInput(raw);
			if (normalized !== void 0) provider.apiKey = normalized;
			continue;
		}
		provider[key] = raw;
	}
	return Object.keys(provider).length > 0 ? provider : void 0;
}
function normalizeTalkProviders(value) {
	if (!isRecord(value)) return;
	const providers = {};
	for (const [rawProviderId, providerConfig] of Object.entries(value)) {
		const providerId = normalizeOptionalString(rawProviderId);
		if (!providerId) continue;
		const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
		if (!normalizedProvider) continue;
		providers[providerId] = {
			...providers[providerId],
			...normalizedProvider
		};
	}
	return Object.keys(providers).length > 0 ? providers : void 0;
}
function activeProviderFromTalk(talk) {
	const provider = normalizeOptionalString(talk.provider);
	const providers = talk.providers;
	if (provider) {
		if (providers && !(provider in providers)) return;
		return provider;
	}
	const providerIds = providers ? Object.keys(providers) : [];
	return providerIds.length === 1 ? providerIds[0] : void 0;
}
function normalizeTalkSection(value) {
	if (!isRecord(value)) return;
	const source = value;
	const normalized = {};
	const speechLocale = normalizeOptionalString(source.speechLocale);
	if (speechLocale) normalized.speechLocale = speechLocale;
	if (typeof source.interruptOnSpeech === "boolean") normalized.interruptOnSpeech = source.interruptOnSpeech;
	const silenceTimeoutMs = normalizeSilenceTimeoutMs(source.silenceTimeoutMs);
	if (silenceTimeoutMs !== void 0) normalized.silenceTimeoutMs = silenceTimeoutMs;
	const providers = normalizeTalkProviders(source.providers);
	const provider = normalizeOptionalString(source.provider);
	if (providers) normalized.providers = providers;
	if (provider) normalized.provider = provider;
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeTalkConfig(config) {
	if (!config.talk) return config;
	const normalizedTalk = normalizeTalkSection(config.talk);
	if (!normalizedTalk) return config;
	return {
		...config,
		talk: normalizedTalk
	};
}
function resolveActiveTalkProviderConfig(talk) {
	const normalizedTalk = normalizeTalkSection(talk);
	if (!normalizedTalk) return;
	const provider = activeProviderFromTalk(normalizedTalk);
	if (!provider) return;
	return {
		provider,
		config: normalizedTalk.providers?.[provider] ?? {}
	};
}
function buildTalkConfigResponse(value) {
	if (!isRecord(value)) return;
	const normalized = normalizeTalkSection(value);
	const legacyCompat = buildLegacyTalkProviderCompat(value);
	if (!normalized && !legacyCompat) return;
	const payload = {};
	if (typeof normalized?.interruptOnSpeech === "boolean") payload.interruptOnSpeech = normalized.interruptOnSpeech;
	if (typeof normalized?.silenceTimeoutMs === "number") payload.silenceTimeoutMs = normalized.silenceTimeoutMs;
	if (typeof normalized?.speechLocale === "string") payload.speechLocale = normalized.speechLocale;
	if (normalized?.providers && Object.keys(normalized.providers).length > 0) payload.providers = normalized.providers;
	const resolved = resolveActiveTalkProviderConfig(normalized) ?? (legacyCompat ? {
		provider: "elevenlabs",
		config: legacyCompat
	} : void 0);
	const activeProvider = normalizeOptionalString(normalized?.provider) ?? resolved?.provider;
	if (activeProvider) payload.provider = activeProvider;
	if (resolved) payload.resolved = resolved;
	return Object.keys(payload).length > 0 ? payload : void 0;
}
//#endregion
export { resolveActiveTalkProviderConfig as i, normalizeTalkConfig as n, normalizeTalkSection as r, buildTalkConfigResponse as t };
