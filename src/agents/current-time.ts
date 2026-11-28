/**
 * Formats cron-style current-time prompt text with local and UTC references.
 */
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "./date-time.js";

type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

type TimeConfigLike = {
  agents?: {
    defaults?: {
      userTimezone?: string;
    };
  };
};

/** Resolve localized and UTC current-time text for agent prompts. */
export function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow {
  const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(undefined);
  const timestampMs = resolveDateTimestampMs(nowMs);
  const date = new Date(timestampMs);
  const formattedTime = formatUserTime(date, userTimezone, userTimeFormat) ?? date.toISOString();
  const utcTime = date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone})\nReference UTC: ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

// Only refresh our own two-line block. The UTC tail distinguishes it from authored
// reminders while permitting locale-dependent text in the first line (#44993).
const CURRENT_TIME_LINE_RE =
  /^Current time: .+? \([^)]+\)\nReference UTC: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/gm;

export function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number) {
  const base = text.trimEnd();
  if (!base) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs);
  if (!CURRENT_TIME_LINE_RE.test(base)) {
    return `${base}\n${timeLine}`;
  }
  CURRENT_TIME_LINE_RE.lastIndex = 0;
  let replaced = false;
  const refreshed = base.replace(CURRENT_TIME_LINE_RE, () => {
    if (replaced) {
      return "";
    }
    replaced = true;
    return timeLine;
  });
  return refreshed
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n+(?=Current time:)/g, "\n")
    .trimEnd();
}
