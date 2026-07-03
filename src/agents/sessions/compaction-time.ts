/**
 * Resolve a compaction entry timestamp into epoch milliseconds.
 *
 * Returns `undefined` when the entry is null, the timestamp is unparseable,
 * or the parsed value is non-finite/non-positive — a deliberate fallback.
 * Callers treat `undefined` as "boundary unreliable" and skip the guard so
 * compaction is checked normally rather than silently suppressed by malformed
 * compaction-entry data.
 *
 * Validation layers (each invalid case returns `undefined`):
 * 1. Null / missing entry
 * 2. Date.parse produces NaN (loose/non-date/garbage strings)
 * 3. Non-finite result (overflow to Infinity)
 * 4. Non-positive result (epoch-zero or pre-epoch timestamps)
 */
export function resolveCompactionTime(entry: { timestamp: string } | null): number | undefined {
  if (!entry) {
    return undefined;
  }
  const time = new Date(entry.timestamp).getTime();
  if (Number.isNaN(time)) {
    return undefined;
  }
  // Guard against overflow and pre-epoch timestamps.  A compaction entry
  // must have a positive, finite epoch-ms value — anything else is data
  // corruption and the boundary is treated as unreliable.
  if (!Number.isFinite(time) || time <= 0) {
    return undefined;
  }
  return time;
}
