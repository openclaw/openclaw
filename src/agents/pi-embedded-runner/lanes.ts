import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string, { inner }: { inner?: boolean } = {}) {
  const cleaned = lane?.trim();
  // Only remap cron→nested for inner operations (compaction, followup) to avoid
  // deadlock with the cron lane slot. The top-level cron dispatch must stay on
  // CommandLane.Cron so that cron.maxConcurrentRuns is honoured.
  if (inner && cleaned === CommandLane.Cron) {
    return CommandLane.Nested;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
