import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  if (!cleaned) {
    return CommandLane.Main;
  }
  // Isolated cron runs already execute inside the outer cron service lane.
  // Re-enqueuing embedded work onto the same global "cron" lane causes a
  // self-deadlock: the outer cron task awaits an inner task that cannot start
  // until the outer task releases the lane. Use the existing nested lane for
  // the embedded portion instead.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.Nested;
  }
  return cleaned;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
