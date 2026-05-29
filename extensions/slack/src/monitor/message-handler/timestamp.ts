const SLACK_TIMESTAMP_RE = /^\d+(?:\.\d+)?$/;

export function resolveSlackTimestampMs(ts: string | undefined): number | undefined {
  const trimmed = ts?.trim();
  if (!trimmed || !SLACK_TIMESTAMP_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : undefined;
}
