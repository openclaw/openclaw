import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as resolveThreadBindingLifecycle } from "./thread-binding-lifecycle-BL-h7xfb.js";
import { t as resolveBundledChannelThreadBindingDefaultPlacement } from "./thread-binding-api-tBMd1vH5.js";
//#region src/channels/thread-bindings-policy.ts
const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;
function normalizeChannelId(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function supportsAutomaticThreadBindingSpawn(channel) {
	return resolveDefaultTopLevelPlacement(channel) === "child";
}
function requiresNativeThreadContextForThreadHere(channel) {
	return resolveDefaultTopLevelPlacement(channel) === "child";
}
function resolveThreadBindingPlacementForCurrentContext(params) {
	if (resolveDefaultTopLevelPlacement(params.channel) !== "child") return "current";
	return params.threadId ? "current" : "child";
}
function resolveDefaultTopLevelPlacement(channel) {
	const normalized = normalizeChannelId(channel);
	if (!normalized) return "current";
	return getLoadedChannelPlugin(normalized)?.conversationBindings?.defaultTopLevelPlacement ?? resolveBundledChannelThreadBindingDefaultPlacement(normalized) ?? "current";
}
function normalizeBoolean(value) {
	if (typeof value !== "boolean") return;
	return value;
}
function normalizeThreadBindingHours(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	if (raw < 0) return;
	return raw;
}
function resolveThreadBindingIdleTimeoutMs(params) {
	const idleHours = normalizeThreadBindingHours(params.channelIdleHoursRaw) ?? normalizeThreadBindingHours(params.sessionIdleHoursRaw) ?? DEFAULT_THREAD_BINDING_IDLE_HOURS;
	return Math.floor(idleHours * 60 * 60 * 1e3);
}
function resolveThreadBindingMaxAgeMs(params) {
	const maxAgeHours = normalizeThreadBindingHours(params.channelMaxAgeHoursRaw) ?? normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ?? DEFAULT_THREAD_BINDING_MAX_AGE_HOURS;
	return Math.floor(maxAgeHours * 60 * 60 * 1e3);
}
function resolveThreadBindingEffectiveExpiresAt(params) {
	return resolveThreadBindingLifecycle(params).expiresAt;
}
function resolveThreadBindingsEnabled(params) {
	return normalizeBoolean(params.channelEnabledRaw) ?? normalizeBoolean(params.sessionEnabledRaw) ?? true;
}
function resolveChannelThreadBindings(params) {
	const channelConfig = params.cfg.channels?.[params.channel];
	const accountConfig = channelConfig?.accounts?.[params.accountId];
	return {
		root: channelConfig?.threadBindings,
		account: accountConfig?.threadBindings
	};
}
function resolveSpawnFlagKey(kind) {
	return kind === "subagent" ? "spawnSubagentSessions" : "spawnAcpSessions";
}
function normalizeSpawnContext(value) {
	return value === "isolated" || value === "fork" ? value : void 0;
}
function resolveThreadBindingSpawnPolicy(params) {
	const channel = normalizeChannelId(params.channel);
	const accountId = normalizeAccountId(params.accountId);
	const { root, account } = resolveChannelThreadBindings({
		cfg: params.cfg,
		channel,
		accountId
	});
	const enabled = normalizeBoolean(account?.enabled) ?? normalizeBoolean(root?.enabled) ?? normalizeBoolean(params.cfg.session?.threadBindings?.enabled) ?? true;
	const spawnFlagKey = resolveSpawnFlagKey(params.kind);
	return {
		channel,
		accountId,
		enabled,
		spawnEnabled: normalizeBoolean(account?.[spawnFlagKey]) ?? normalizeBoolean(account?.spawnSessions) ?? normalizeBoolean(root?.[spawnFlagKey]) ?? normalizeBoolean(root?.spawnSessions) ?? normalizeBoolean(params.cfg.session?.threadBindings?.spawnSessions) ?? true,
		defaultSpawnContext: normalizeSpawnContext(account?.defaultSpawnContext) ?? normalizeSpawnContext(root?.defaultSpawnContext) ?? normalizeSpawnContext(params.cfg.session?.threadBindings?.defaultSpawnContext) ?? "fork"
	};
}
function resolveThreadBindingIdleTimeoutMsForChannel(params) {
	const { root, account } = resolveThreadBindingChannelScope(params);
	return resolveThreadBindingIdleTimeoutMs({
		channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
		sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours
	});
}
function resolveThreadBindingMaxAgeMsForChannel(params) {
	const { root, account } = resolveThreadBindingChannelScope(params);
	return resolveThreadBindingMaxAgeMs({
		channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
		sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours
	});
}
function resolveThreadBindingChannelScope(params) {
	const channel = normalizeChannelId(params.channel);
	const accountId = normalizeAccountId(params.accountId);
	return resolveChannelThreadBindings({
		cfg: params.cfg,
		channel,
		accountId
	});
}
function formatThreadBindingDisabledError(params) {
	return `Thread bindings are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).`;
}
function formatThreadBindingSpawnDisabledError(params) {
	return `Thread-bound session spawns are disabled for ${params.channel} (set channels.${params.channel}.threadBindings.spawnSessions=true to enable).`;
}
//#endregion
export { resolveThreadBindingIdleTimeoutMs as a, resolveThreadBindingMaxAgeMsForChannel as c, resolveThreadBindingsEnabled as d, supportsAutomaticThreadBindingSpawn as f, resolveThreadBindingEffectiveExpiresAt as i, resolveThreadBindingPlacementForCurrentContext as l, formatThreadBindingSpawnDisabledError as n, resolveThreadBindingIdleTimeoutMsForChannel as o, requiresNativeThreadContextForThreadHere as r, resolveThreadBindingMaxAgeMs as s, formatThreadBindingDisabledError as t, resolveThreadBindingSpawnPolicy as u };
