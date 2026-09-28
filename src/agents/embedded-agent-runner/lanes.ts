/**
 * Resolves command queue lane names for embedded-agent sessions and global work.
 */
import {
  CommandLane,
  SUBAGENT_LANE_PREFIX,
  type CommandLaneConfiguration,
} from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(
  lane?: string,
  context?: {
    spawnedBy?: string | null;
    sessionKey?: string;
    sessionId: string;
    swarmExecutionLane?: CommandLaneConfiguration;
  },
) {
  const cleaned = lane?.trim();
  // Cron jobs hold the cron lane slot; inner operations need a dedicated lane
  // to avoid deadlock without widening shared nested flows.
  if (cleaned === CommandLane.Cron) {
    return CommandLane.CronNested;
  }
  if (cleaned === CommandLane.Subagent) {
    if (context?.swarmExecutionLane) {
      return context.swarmExecutionLane.lane;
    }
    // Immediate parents own their children's budget, so an orchestrator can
    // await descendants without holding the capacity those descendants need.
    const owner =
      context?.spawnedBy?.trim() || context?.sessionKey?.trim() || context?.sessionId.trim();
    if (!owner) {
      throw new Error("Subagent command lane requires a parent or current session identity.");
    }
    return `${SUBAGENT_LANE_PREFIX}${owner}`;
  }
  return cleaned ? cleaned : CommandLane.Main;
}

export { resolveSessionLane as resolveEmbeddedSessionLane };
