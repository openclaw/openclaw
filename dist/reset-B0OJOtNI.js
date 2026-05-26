import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { k as resolveLoadedSessionThreadInfo } from "./store-load-z4thf6ld.js";
//#region src/config/sessions/reset-policy.ts
const DEFAULT_RESET_MODE = "daily";
function resolveDailyResetAtMs(now, atHour) {
	const normalizedAtHour = normalizeResetAtHour(atHour);
	const resetAt = new Date(now);
	resetAt.setHours(normalizedAtHour, 0, 0, 0);
	if (now < resetAt.getTime()) resetAt.setDate(resetAt.getDate() - 1);
	return resetAt.getTime();
}
function resolveSessionResetPolicy(params) {
	const sessionCfg = params.sessionCfg;
	const baseReset = params.resetOverride ?? sessionCfg?.reset;
	const typeReset = params.resetOverride ? void 0 : sessionCfg?.resetByType?.[params.resetType] ?? (params.resetType === "direct" ? (sessionCfg?.resetByType)?.dm : void 0);
	const hasExplicitReset = Boolean(baseReset || sessionCfg?.resetByType);
	const legacyIdleMinutes = params.resetOverride ? void 0 : sessionCfg?.idleMinutes;
	const configured = Boolean(baseReset || typeReset || legacyIdleMinutes != null);
	const mode = typeReset?.mode ?? baseReset?.mode ?? (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : "daily");
	const atHour = normalizeResetAtHour(typeReset?.atHour ?? baseReset?.atHour ?? 4);
	const idleMinutesRaw = typeReset?.idleMinutes ?? baseReset?.idleMinutes ?? legacyIdleMinutes;
	let idleMinutes;
	if (idleMinutesRaw != null) {
		const normalized = Math.floor(idleMinutesRaw);
		if (Number.isFinite(normalized)) idleMinutes = Math.max(normalized, 0);
	} else if (mode === "idle") idleMinutes = 0;
	return {
		mode,
		atHour,
		idleMinutes,
		configured
	};
}
function evaluateSessionFreshness(params) {
	const updatedAt = resolveTimestamp(params.updatedAt, params.now) ?? 0;
	const sessionStartedAt = resolveTimestamp(params.sessionStartedAt, params.now) ?? updatedAt;
	const lastInteractionAt = resolveTimestamp(params.lastInteractionAt, params.now) ?? sessionStartedAt;
	const dailyResetAt = params.policy.mode === "daily" ? resolveDailyResetAtMs(params.now, params.policy.atHour) : void 0;
	const idleExpiresAt = params.policy.idleMinutes != null && params.policy.idleMinutes > 0 ? lastInteractionAt + params.policy.idleMinutes * 6e4 : void 0;
	const staleDaily = dailyResetAt != null && sessionStartedAt < dailyResetAt;
	const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
	return {
		fresh: !(staleDaily || staleIdle),
		dailyResetAt,
		idleExpiresAt
	};
}
function resolveTimestamp(value, now) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
	if (typeof now === "number" && Number.isFinite(now) && value > now) return;
	return value;
}
function normalizeResetAtHour(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 4;
	const normalized = Math.floor(value);
	if (!Number.isFinite(normalized)) return 4;
	if (normalized < 0) return 0;
	if (normalized > 23) return 23;
	return normalized;
}
//#endregion
//#region src/config/sessions/reset.ts
const GROUP_SESSION_MARKERS = [":group:", ":channel:"];
function isThreadSessionKey(sessionKey) {
	return Boolean(resolveLoadedSessionThreadInfo(sessionKey).threadId);
}
function resolveSessionResetType(params) {
	if (params.isThread || isThreadSessionKey(params.sessionKey)) return "thread";
	if (params.isGroup) return "group";
	const normalized = normalizeLowercaseStringOrEmpty(params.sessionKey);
	if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) return "group";
	return "direct";
}
function resolveThreadFlag(params) {
	if (params.messageThreadId != null) return true;
	if (params.threadLabel?.trim()) return true;
	if (params.threadStarterBody?.trim()) return true;
	if (params.parentSessionKey?.trim()) return true;
	return isThreadSessionKey(params.sessionKey);
}
function resolveChannelResetConfig(params) {
	const resetByChannel = params.sessionCfg?.resetByChannel;
	if (!resetByChannel) return;
	const normalized = normalizeMessageChannel(params.channel);
	const fallback = normalizeOptionalLowercaseString(params.channel);
	const key = normalized ?? fallback;
	if (!key) return;
	return resetByChannel[key];
}
//#endregion
export { DEFAULT_RESET_MODE as a, resolveSessionResetPolicy as c, resolveThreadFlag as i, resolveChannelResetConfig as n, evaluateSessionFreshness as o, resolveSessionResetType as r, resolveDailyResetAtMs as s, isThreadSessionKey as t };
