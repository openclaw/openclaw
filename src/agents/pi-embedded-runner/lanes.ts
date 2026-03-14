import { CommandLane } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveAgentGlobalLane(agentId?: string) {
  const cleaned = agentId?.trim();
  return cleaned ? `agent:${cleaned}` : CommandLane.Main;
}

export function resolveGlobalLane(lane?: string, agentId?: string) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations must use nested to avoid deadlock.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.Nested;
  }
  return cleaned ? cleaned : resolveAgentGlobalLane(agentId);
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}
