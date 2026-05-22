import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as parseAbsoluteTimeMs } from "./stagger-Bn6ApiDa.js";
import { Cron } from "croner";
//#region src/cron/schedule.ts
const CRON_EVAL_CACHE_MAX = 512;
const cronEvalCache = /* @__PURE__ */ new Map();
function resolveCronTimezone(tz) {
	const trimmed = normalizeOptionalString(tz) ?? "";
	if (trimmed) return trimmed;
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function resolveCachedCron(expr, timezone) {
	const key = `${timezone}\u0000${expr}`;
	const cached = cronEvalCache.get(key);
	if (cached) {
		cronEvalCache.delete(key);
		cronEvalCache.set(key, cached);
		return cached;
	}
	if (cronEvalCache.size >= CRON_EVAL_CACHE_MAX) {
		const oldest = cronEvalCache.keys().next().value;
		if (oldest) cronEvalCache.delete(oldest);
	}
	const next = new Cron(expr, {
		timezone,
		catch: false
	});
	cronEvalCache.set(key, next);
	return next;
}
function resolveCronFromSchedule(schedule) {
	const exprSource = typeof schedule.expr === "string" ? schedule.expr : schedule.cron;
	if (typeof exprSource !== "string") throw new Error("invalid cron schedule: expr is required");
	const expr = exprSource.trim();
	if (!expr) return;
	return resolveCachedCron(expr, resolveCronTimezone(schedule.tz));
}
function coerceFiniteScheduleNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function computeNextRunAtMs(schedule, nowMs) {
	if (schedule.kind === "at") {
		const sched = schedule;
		const atMs = typeof sched.atMs === "number" && Number.isFinite(sched.atMs) && sched.atMs > 0 ? sched.atMs : typeof sched.atMs === "string" ? parseAbsoluteTimeMs(sched.atMs) : typeof sched.at === "string" ? parseAbsoluteTimeMs(sched.at) : null;
		if (atMs === null) return;
		return atMs > nowMs ? atMs : void 0;
	}
	if (schedule.kind === "every") {
		const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
		if (everyMsRaw === void 0) return;
		const everyMs = Math.max(1, Math.floor(everyMsRaw));
		const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
		const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
		if (nowMs < anchor) return anchor;
		const elapsed = nowMs - anchor;
		return anchor + Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs)) * everyMs;
	}
	const cron = resolveCronFromSchedule(schedule);
	if (!cron) return;
	let next = cron.nextRun(new Date(nowMs));
	if (!next) return;
	let nextMs = next.getTime();
	if (!Number.isFinite(nextMs)) return;
	if (nextMs <= nowMs) {
		const nextSecondMs = Math.floor(nowMs / 1e3) * 1e3 + 1e3;
		const retry = cron.nextRun(new Date(nextSecondMs));
		if (retry) {
			const retryMs = retry.getTime();
			if (Number.isFinite(retryMs) && retryMs > nowMs) return retryMs;
		}
		const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
		const retry2 = cron.nextRun(new Date(tomorrowMs));
		if (retry2) {
			const retry2Ms = retry2.getTime();
			if (Number.isFinite(retry2Ms) && retry2Ms > nowMs) return retry2Ms;
		}
		return;
	}
	return nextMs;
}
function computePreviousRunAtMs(schedule, nowMs) {
	if (schedule.kind !== "cron") return;
	const cron = resolveCronFromSchedule(schedule);
	if (!cron) return;
	const previous = cron.previousRuns(1, new Date(nowMs))[0];
	if (!previous) return;
	const previousMs = previous.getTime();
	if (!Number.isFinite(previousMs)) return;
	if (previousMs >= nowMs) return;
	return previousMs;
}
//#endregion
export { computeNextRunAtMs as n, computePreviousRunAtMs as r, coerceFiniteScheduleNumber as t };
