const MS_EPOCH_MIN = 1_000_000_000_000;

/** Some payloads use seconds, others milliseconds. Values below 1e12 are epoch-seconds. */
export function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}
