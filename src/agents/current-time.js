import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone, } from "./date-time.js";
export function resolveCronStyleNow(cfg, nowMs) {
    const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
    const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
    const formattedTime = formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
    const timeLine = `Current time: ${formattedTime} (${userTimezone})`;
    return { userTimezone, formattedTime, timeLine };
}
export function appendCronStyleCurrentTimeLine(text, cfg, nowMs) {
    const base = text.trimEnd();
    if (!base || base.includes("Current time:")) {
        return base;
    }
    const { timeLine } = resolveCronStyleNow(cfg, nowMs);
    return `${base}\n${timeLine}`;
}
