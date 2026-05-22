import { i as resolveUserTimezone, r as resolveUserTimeFormat, t as formatUserTime } from "./date-time-fkqpYDtT.js";
//#region src/agents/current-time.ts
function resolveCronStyleNow(cfg, nowMs) {
	const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
	const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
	const formattedTime = formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
	return {
		userTimezone,
		formattedTime,
		timeLine: `Current time: ${formattedTime} (${userTimezone}) / ${new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC"}`
	};
}
function appendCronStyleCurrentTimeLine(text, cfg, nowMs) {
	const base = text.trimEnd();
	if (!base || base.includes("Current time:")) return base;
	const { timeLine } = resolveCronStyleNow(cfg, nowMs);
	return `${base}\n${timeLine}`;
}
//#endregion
export { resolveCronStyleNow as n, appendCronStyleCurrentTimeLine as t };
