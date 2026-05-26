import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as normalizeTtsAutoMode } from "./tts-auto-mode-CHJnGxS9.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
//#region src/tts/tts-config.ts
const BLOCKED_MERGE_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function deepMergeDefined(base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return override === void 0 ? base : override;
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (BLOCKED_MERGE_KEYS.has(key) || value === void 0) continue;
		const existing = result[key];
		result[key] = key in result ? deepMergeDefined(existing, value) : value;
	}
	return result;
}
function resolveAgentTtsOverride(cfg, agentId) {
	if (!agentId || !Array.isArray(cfg.agents?.list)) return;
	const normalized = normalizeAgentId(agentId);
	return cfg.agents.list.find((entry) => normalizeAgentId(entry.id) === normalized)?.tts;
}
function resolveTtsConfigContext(contextOrAgentId) {
	return typeof contextOrAgentId === "string" ? { agentId: contextOrAgentId } : contextOrAgentId ?? {};
}
function resolveRecordEntry(entries, id, normalize) {
	const normalizedId = normalizeOptionalString(id);
	if (!entries || !normalizedId) return;
	if (Object.hasOwn(entries, normalizedId)) return entries[normalizedId];
	const normalized = normalize(normalizedId);
	const key = Object.keys(entries).find((candidate) => normalize(candidate) === normalized);
	return key ? entries[key] : void 0;
}
function asTtsConfig(value) {
	return isPlainObject(value) ? value : void 0;
}
function asObjectRecord(value) {
	return isPlainObject(value) ? value : void 0;
}
function resolveChannelConfig(cfg, channelId) {
	if (!isPlainObject(cfg.channels)) return;
	const normalizedChannelId = normalizeOptionalString(channelId);
	if (!normalizedChannelId) return;
	return asObjectRecord(resolveRecordEntry(cfg.channels, normalizedChannelId, normalizeLowercaseStringOrEmpty));
}
function resolveChannelTtsOverride(cfg, context) {
	return asTtsConfig(resolveChannelConfig(cfg, context.channelId)?.tts);
}
function resolveAccountTtsOverride(cfg, context) {
	const channelConfig = resolveChannelConfig(cfg, context.channelId);
	return asTtsConfig(asObjectRecord(resolveRecordEntry(isPlainObject(channelConfig?.accounts) ? channelConfig.accounts : void 0, context.accountId, normalizeAccountId))?.tts);
}
function resolveEffectiveTtsConfig(cfg, contextOrAgentId) {
	const context = resolveTtsConfigContext(contextOrAgentId);
	const base = cfg.messages?.tts ?? {};
	const agentOverride = resolveAgentTtsOverride(cfg, context.agentId);
	const channelOverride = resolveChannelTtsOverride(cfg, context);
	const accountOverride = resolveAccountTtsOverride(cfg, context);
	let merged = base;
	for (const override of [
		agentOverride,
		channelOverride,
		accountOverride
	]) merged = deepMergeDefined(merged, override ?? {});
	return merged;
}
function resolveConfiguredTtsMode(cfg, contextOrAgentId) {
	return resolveEffectiveTtsConfig(cfg, contextOrAgentId).mode ?? "final";
}
function resolveTtsPrefsPathValue(prefsPath) {
	if (prefsPath?.trim()) return resolveUserPath(prefsPath.trim());
	const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
	if (envPath) return resolveUserPath(envPath);
	return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}
function readTtsPrefsAutoMode(prefsPath) {
	try {
		if (!existsSync(prefsPath)) return;
		const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
		const auto = normalizeTtsAutoMode(prefs.tts?.auto);
		if (auto) return auto;
		if (typeof prefs.tts?.enabled === "boolean") return prefs.tts.enabled ? "always" : "off";
	} catch {
		return;
	}
}
function shouldAttemptTtsPayload(params) {
	const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
	if (sessionAuto) return sessionAuto !== "off";
	const raw = resolveEffectiveTtsConfig(params.cfg, params);
	const prefsAuto = readTtsPrefsAutoMode(resolveTtsPrefsPathValue(raw?.prefsPath));
	if (prefsAuto) return prefsAuto !== "off";
	const configuredAuto = normalizeTtsAutoMode(raw?.auto);
	if (configuredAuto) return configuredAuto !== "off";
	return raw?.enabled === true;
}
function shouldCleanTtsDirectiveText(params) {
	if (!shouldAttemptTtsPayload(params)) return false;
	return resolveEffectiveTtsConfig(params.cfg, params).modelOverrides?.enabled !== false;
}
//#endregion
export { shouldCleanTtsDirectiveText as i, resolveEffectiveTtsConfig as n, shouldAttemptTtsPayload as r, resolveConfiguredTtsMode as t };
