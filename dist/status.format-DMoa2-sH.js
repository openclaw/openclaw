import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as formatRuntimeStatusWithDetails } from "./runtime-status-Bg5sKikV.js";
import { r as formatDurationPrecise } from "./format-duration-BrZ-AaEJ.js";
//#region src/commands/status.format.ts
const formatKTokens = (value) => `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
const formatDuration = (ms) => {
	if (ms == null || !Number.isFinite(ms)) return "unknown";
	return formatDurationPrecise(ms, { decimals: 1 });
};
const formatTokensCompact = (sess) => {
	const used = sess.totalTokens;
	const ctx = sess.contextTokens;
	let result = "";
	if (used == null) result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
	else if (!ctx) result = `${formatKTokens(used)} used`;
	else {
		const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
		result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
	}
	const cacheStats = resolvePromptCacheStats(sess);
	if (cacheStats && cacheStats.cacheRead > 0) result += ` · 🗄️ ${cacheStats.hitRate}% cached`;
	return result;
};
const formatPromptCacheCompact = (sess) => {
	const cacheStats = resolvePromptCacheStats(sess);
	if (!cacheStats) return "";
	const parts = [`${cacheStats.hitRate}% hit`];
	if (cacheStats.cacheRead > 0) parts.push(`read ${formatKTokens(cacheStats.cacheRead)}`);
	if (cacheStats.cacheWrite > 0) parts.push(`write ${formatKTokens(cacheStats.cacheWrite)}`);
	return parts.join(" · ");
};
function resolvePromptCacheStats(sess) {
	const cacheRead = typeof sess.cacheRead === "number" && Number.isFinite(sess.cacheRead) && sess.cacheRead >= 0 ? sess.cacheRead : 0;
	const cacheWrite = typeof sess.cacheWrite === "number" && Number.isFinite(sess.cacheWrite) && sess.cacheWrite >= 0 ? sess.cacheWrite : 0;
	if (cacheRead <= 0 && cacheWrite <= 0) return null;
	const inputTokens = typeof sess.inputTokens === "number" && Number.isFinite(sess.inputTokens) && sess.inputTokens >= 0 ? sess.inputTokens : void 0;
	const promptTokensFromParts = inputTokens != null ? inputTokens + cacheRead + cacheWrite : void 0;
	const used = sess.totalTokens;
	const total = promptTokensFromParts ?? (typeof used === "number" && Number.isFinite(used) && used > 0 ? Math.max(used, cacheRead + cacheWrite) : cacheRead + cacheWrite);
	return {
		cacheRead,
		cacheWrite,
		hitRate: total > 0 ? Math.round(cacheRead / total * 100) : 0
	};
}
const formatDaemonRuntimeShort = (runtime) => {
	if (!runtime) return null;
	const details = [];
	const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
	const noisyLaunchctlDetail = runtime.missingUnit === true && normalizeLowercaseStringOrEmpty(detail).includes("could not find service");
	if (detail && !noisyLaunchctlDetail) details.push(detail);
	return formatRuntimeStatusWithDetails({
		status: runtime.status,
		pid: runtime.pid,
		state: runtime.state,
		details
	});
};
//#endregion
export { formatTokensCompact as a, formatPromptCacheCompact as i, formatDuration as n, formatKTokens as r, formatDaemonRuntimeShort as t };
