const FEEDBACK_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

export function isFeishuMessageFeedbackStale(timestamp: number | undefined): boolean {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return false;
  }
  // Feishu payloads can use seconds or milliseconds; keep replay notifications suppressed.
  const createdAtMs = timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
  return Date.now() - createdAtMs > FEEDBACK_MAX_AGE_MS;
}
