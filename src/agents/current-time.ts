import {
  type TimeFormatPreference,
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";

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
  const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
  const utcTime = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone}) / ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

// Matches the helper's own injected `Current time: ...` line. The natural-language
// `formattedTime` portion is locale/format-dependent (e.g. `Thursday, April 30th, 2026 - 10:00 AM`
// from `formatUserTime`, or an ISO fallback), so we anchor on the helper-only deterministic
// suffix: ` (<userTimezone>) / YYYY-MM-DD HH:MM UTC`. The `(TZ)` group rejects parens (so
// timezone IDs like `Asia/Seoul` are accepted), and the strict ISO+UTC tail rejects
// user-authored reminder lines that happen to start with `Current time:` but lack the
// helper's exact tail format.
const CURRENT_TIME_LINE_RE =
  /^Current time: .+? \([^)]+\) \/ \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/gm;

export function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number) {
  const base = text.trimEnd();
  if (!base) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs);
  if (!CURRENT_TIME_LINE_RE.test(base)) {
    return `${base}\n${timeLine}`;
  }
  // Refresh existing line(s): collapse all matches to a single fresh entry so
  // heartbeat/cron prompts that flow through this helper repeatedly do not
  // leak a stale `Current time:` value (issue #44993). Reset lastIndex because
  // RegExp objects with the global flag carry state across calls.
  CURRENT_TIME_LINE_RE.lastIndex = 0;
  let replaced = false;
  const refreshed = base.replace(CURRENT_TIME_LINE_RE, () => {
    if (replaced) {
      return "";
    }
    replaced = true;
    return timeLine;
  });
  // Remove any blank lines left behind by collapsed duplicates.
  return refreshed
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n+(?=Current time:)/g, "\n")
    .trimEnd();
}
