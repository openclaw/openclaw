import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentUserTimezone } from "./agent-scope.js";
import { formatUserTime, resolveUserTimeFormat } from "./date-time.js";

export type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

export function resolveCronStyleNow(
  cfg: OpenClawConfig,
  nowMs: number,
  agentId?: string,
): CronStyleNow {
  const userTimezone = resolveAgentUserTimezone(cfg, agentId);
  const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
  const utcTime = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone}) / ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

export function appendCronStyleCurrentTimeLine(
  text: string,
  cfg: OpenClawConfig,
  nowMs: number,
  agentId?: string,
) {
  const base = text.trimEnd();
  if (!base || base.includes("Current time:")) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs, agentId);
  return `${base}\n${timeLine}`;
}
