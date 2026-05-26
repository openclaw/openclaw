import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { n as normalizeTtsAutoMode } from "./tts-auto-mode-CHJnGxS9.js";
import { n as resolveEffectiveTtsConfig } from "./tts-config-WOpwhkHq.js";
import path from "node:path";
//#region src/tts/status-config.ts
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const MAX_STATUS_DETAIL_LENGTH = 96;
function resolveConfiguredTtsAutoMode(raw) {
	return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}
function normalizeConfiguredSpeechProviderId(providerId) {
	const normalized = normalizeOptionalLowercaseString(providerId);
	if (!normalized) return;
	return normalized === "edge" ? "microsoft" : normalized;
}
function normalizeTtsPersonaId(personaId) {
	return normalizeOptionalLowercaseString(personaId ?? void 0);
}
function resolvePersonaPreferredProvider(raw, personaId) {
	if (!personaId || !raw.personas) return;
	for (const [id, persona] of Object.entries(raw.personas)) {
		if (normalizeTtsPersonaId(id) !== personaId) continue;
		return normalizeOptionalString(normalizeConfiguredSpeechProviderId(persona.provider) ?? persona.provider);
	}
}
function resolveTtsPrefsPathValue(prefsPath) {
	const configuredPath = normalizeOptionalString(prefsPath);
	if (configuredPath) return resolveUserPath(configuredPath);
	const envPath = normalizeOptionalString(process.env.OPENCLAW_TTS_PREFS);
	if (envPath) return resolveUserPath(envPath);
	return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}
function readPrefs(prefsPath) {
	return tryReadJsonSync(prefsPath) ?? {};
}
function resolveTtsAutoModeFromPrefs(prefs) {
	const auto = normalizeTtsAutoMode(prefs.tts?.auto);
	if (auto) return auto;
	if (typeof prefs.tts?.enabled === "boolean") return prefs.tts.enabled ? "always" : "off";
}
function isObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeStatusDetail(value, maxLength = MAX_STATUS_DETAIL_LENGTH) {
	if (typeof value !== "string") return;
	const normalized = value.trim().replace(/\s+/g, " ");
	if (!normalized) return;
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}
function sanitizeBaseUrlForStatus(value) {
	const raw = normalizeStatusDetail(value, 180);
	if (!raw) return;
	try {
		const parsed = new URL(raw);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return normalizeStatusDetail(parsed.toString().replace(/\/+$/, ""), 120);
	} catch {
		return "[invalid-url]";
	}
}
function isCustomOpenAiTtsBaseUrl(baseUrl) {
	return baseUrl ? baseUrl.replace(/\/+$/, "") !== DEFAULT_OPENAI_TTS_BASE_URL : false;
}
function firstStatusDetail(record, keys) {
	if (!record) return;
	for (const key of keys) {
		const value = normalizeStatusDetail(record[key]);
		if (value) return value;
	}
}
function resolveProviderConfigRecord(raw, provider) {
	const rawRecord = isObjectRecord(raw) ? raw : {};
	const providers = isObjectRecord(raw.providers) ? raw.providers : {};
	if (provider === "microsoft") return {
		...isObjectRecord(rawRecord.edge) ? rawRecord.edge : {},
		...isObjectRecord(rawRecord.microsoft) ? rawRecord.microsoft : {},
		...isObjectRecord(providers.edge) ? providers.edge : {},
		...isObjectRecord(providers.microsoft) ? providers.microsoft : {}
	};
	const direct = rawRecord[provider];
	const providerScoped = providers[provider];
	if (isObjectRecord(providerScoped)) return providerScoped;
	if (isObjectRecord(direct)) return direct;
	return rawRecord;
}
function resolveStatusProviderDetails(raw, provider) {
	if (provider === "auto") return {};
	const record = resolveProviderConfigRecord(raw, provider);
	const sanitizedBaseUrl = sanitizeBaseUrlForStatus(record?.baseUrl);
	const customBaseUrl = provider === "openai" && isCustomOpenAiTtsBaseUrl(sanitizedBaseUrl);
	const details = {};
	const displayName = firstStatusDetail(record, ["displayName"]);
	if (displayName) details.displayName = displayName;
	const model = firstStatusDetail(record, ["model", "modelId"]);
	if (model) details.model = model;
	const voice = firstStatusDetail(record, [
		"voice",
		"voiceId",
		"voiceName"
	]);
	if (voice) details.voice = voice;
	if (sanitizedBaseUrl && (provider !== "openai" || customBaseUrl)) {
		details.baseUrl = sanitizedBaseUrl;
		details.customBaseUrl = customBaseUrl;
	}
	return details;
}
function resolveStatusTtsSnapshot(params) {
	const context = {
		agentId: params.agentId,
		channelId: params.channelId,
		accountId: params.accountId
	};
	const raw = resolveEffectiveTtsConfig(params.cfg, context);
	const prefs = readPrefs(resolveTtsPrefsPathValue(raw.prefsPath));
	const autoMode = normalizeTtsAutoMode(params.sessionAuto) ?? resolveTtsAutoModeFromPrefs(prefs) ?? resolveConfiguredTtsAutoMode(raw);
	if (autoMode === "off") return null;
	const persona = prefs.tts && Object.prototype.hasOwnProperty.call(prefs.tts, "persona") ? normalizeTtsPersonaId(prefs.tts.persona) : normalizeTtsPersonaId(raw.persona);
	const provider = normalizeConfiguredSpeechProviderId(prefs.tts?.provider) ?? resolvePersonaPreferredProvider(raw, persona) ?? normalizeConfiguredSpeechProviderId(raw.provider) ?? "auto";
	return {
		autoMode,
		provider,
		...resolveStatusProviderDetails(raw, provider),
		...persona ? { persona } : {},
		maxLength: prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH,
		summarize: prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE
	};
}
//#endregion
export { resolveStatusTtsSnapshot as t };
