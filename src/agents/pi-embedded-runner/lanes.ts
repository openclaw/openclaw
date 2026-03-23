import { CommandLane } from "../../process/lanes.js";

/**
 * Built-in lanes are shared across multiple runs and must never be treated as
 * clearable.  Only custom (user-defined) lanes are safe to clear when aborting
 * a run, because clearing a built-in lane could cancel unrelated queued work.
 */
const BUILTIN_LANES: ReadonlySet<string> = new Set<string>([
  CommandLane.Main,
  CommandLane.Cron,
  CommandLane.Subagent,
  CommandLane.Nested,
]);

export function isClearableLane(resolvedLane: string): boolean {
  return resolvedLane !== "" && !BUILTIN_LANES.has(resolvedLane);
}

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations must use nested to avoid deadlock.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.Nested;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
