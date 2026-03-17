import {
  type TimeFormatPreference,
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";
import { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
import { formatLocalIsoWithOffset } from "../logging/timestamps.js";

export type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

type TimeConfigLike = {
  agents?: {
    defaults?: {
      userTimezone?: string;
      timeFormat?: TimeFormatPreference;
    };
  };
};

export function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow {
  const now = new Date(nowMs);
  const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(now, userTimezone, userTimeFormat) ?? now.toISOString();
  const compactLocalTime = formatZonedTimestamp(now, { timeZone: userTimezone });
  const localIsoWithOffset = formatLocalIsoWithOffset(now, userTimezone);
  const offset = localIsoWithOffset.match(/([+-]\d{2}:\d{2})$/)?.[1];
  const localTimeDetail =
    compactLocalTime && offset
      ? `${compactLocalTime} (${offset})`
      : compactLocalTime ?? localIsoWithOffset;
  const utcTime = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone}) / Local: ${localTimeDetail} / UTC: ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

export function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number) {
  const base = text.trimEnd();
  if (!base || base.includes("Current time:")) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs);
  return `${base}\n${timeLine}`;
}
