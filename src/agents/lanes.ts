import { CommandLane } from "../process/lanes.js";

export const AGENT_LANE_CRON_NESTED = CommandLane.CronNested;
export const AGENT_LANE_NESTED = CommandLane.Nested;
export const AGENT_LANE_SUBAGENT = CommandLane.Subagent;

export function resolveCronEmbeddedAgentLane(lane?: string): string {
  const trimmed = lane?.trim();
  // Cron jobs already occupy the cron lane while they dispatch embedded work.
  // Route inner runs onto a dedicated cron-nested lane instead of the shared
  // interactive nested lane.
  if (!trimmed || trimmed === "cron") {
    return AGENT_LANE_CRON_NESTED;
  }
  return trimmed;
}

export function resolveNestedAgentLane(lane?: string): string {
  const trimmed = lane?.trim();
  // Nested agent runs should not inherit the cron execution lane. Cron jobs
  // already occupy that lane while they dispatch inner work.
  if (!trimmed || trimmed === "cron") {
    return AGENT_LANE_NESTED;
  }
  return trimmed;
}
