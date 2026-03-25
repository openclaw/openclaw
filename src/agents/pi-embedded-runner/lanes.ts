import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations must use a dedicated
  // cron-nested lane to avoid deadlock without widening the shared nested lane.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.CronNested;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
