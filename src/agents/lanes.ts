import { CommandLane } from "../process/lanes.js";

export const AGENT_LANE_NESTED = CommandLane.Nested;
export const AGENT_LANE_CRON_NESTED = CommandLane.CronNested;
export const AGENT_LANE_SUBAGENT = CommandLane.Subagent;

export function resolveNestedAgentLane(lane?: string): string {
  const trimmed = lane?.trim();
  if (!trimmed) {
    return AGENT_LANE_NESTED;
  }
  return trimmed;
}

export function resolveCronAgentLane(lane?: string): string {
  const trimmed = lane?.trim();
  // Cron jobs already occupy the outer cron lane, so nested agent work needs
  // its own dedicated global lane to avoid self-deadlock without widening the
  // shared nested lane used by agent-to-agent flows.
  if (!trimmed || trimmed === CommandLane.Cron) {
    return AGENT_LANE_CRON_NESTED;
  }
  return trimmed;
}
