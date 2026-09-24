/** Human-readable Codex quota reset times; no account or routing decisions. */
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function formatCalendarResetTime(resetsAtMs: number, nowMs: number): string {
  const resetDate = new Date(resetsAtMs);
  const resetParts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(resetDate.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(resetDate);
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    resetParts.find((entry) => entry.type === type)?.value;
  const dateParts = [part("month"), part("day"), part("year")].filter(Boolean);
  const day =
    dateParts.length > 1 ? `${dateParts[0]} ${dateParts.slice(1).join(", ")}` : dateParts[0];
  const time = [part("hour"), part("minute")].filter(Boolean).join(":");
  const dayPeriod = part("dayPeriod");
  const timeZone = part("timeZoneName");
  return [day, "at", [time, dayPeriod, timeZone].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
}

export function formatRelativeDuration(durationMs: number): string {
  const safeMs = Math.max(1_000, durationMs);
  if (safeMs < ONE_MINUTE_MS) {
    return `${Math.ceil(safeMs / 1000)} seconds`;
  }
  if (safeMs < ONE_HOUR_MS) {
    const minutes = Math.ceil(safeMs / ONE_MINUTE_MS);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (safeMs < ONE_DAY_MS) {
    const hours = Math.ceil(safeMs / ONE_HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(safeMs / ONE_DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function formatResetDuration(resetsAtMs: number, nowMs: number): string {
  const durationMs =
    Math.round(Math.max(ONE_SECOND_MS, resetsAtMs - nowMs) / ONE_SECOND_MS) * ONE_SECOND_MS;
  const days = Math.floor(durationMs / ONE_DAY_MS);
  const hours = Math.floor((durationMs % ONE_DAY_MS) / ONE_HOUR_MS);
  const minutes = Math.floor((durationMs % ONE_HOUR_MS) / ONE_MINUTE_MS);
  const seconds = Math.floor((durationMs % ONE_MINUTE_MS) / ONE_SECOND_MS);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}
