/**
 * Resolves command queue lane names for nested, cron, and subagent work.
 */
import { CommandLane, resolveCronNestedAgentLane } from "../process/lanes.js";

/** Default lane for nested agent work. */
const AGENT_LANE_NESTED = CommandLane.Nested;
const AGENT_LANE_CRON_NESTED = CommandLane.CronNested;
export const AGENT_LANE_SUBAGENT = CommandLane.Subagent;
const AGENT_LANE_CRON: string = CommandLane.Cron;
const NESTED_LANE = "nested";
const NESTED_LANE_PREFIX = `${NESTED_LANE}:`;

/**
 * Resolves the lane for agent work started from cron.
 *
 * Cron inner work is scoped to the owning agent so one agent's cron turn
 * cannot occupy the lane another agent's heartbeat observes. Without an agent
 * id the shared `cron-nested` lane is retained, because an unscoped lane
 * cannot be attributed to an agent.
 */
export function resolveCronAgentLane(lane?: string, agentId?: string): string {
  const trimmed = lane?.trim();
  // Cron jobs already occupy the outer cron lane, so inner agent work needs
  // its own lane to avoid self-deadlock without widening shared nested flows.
  if (!trimmed || trimmed === AGENT_LANE_CRON) {
    const owner = agentId?.trim();
    return owner ? resolveCronNestedAgentLane(owner) : AGENT_LANE_CRON_NESTED;
  }
  return trimmed;
}

/** Resolves a per-session nested lane to serialize nested agent work. */
export function resolveNestedAgentLaneForSession(sessionKey: string | undefined): string {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return AGENT_LANE_NESTED;
  }
  return `${NESTED_LANE_PREFIX}${trimmed}`;
}

/** Returns true when a lane belongs to nested agent work. */
export function isNestedAgentLane(lane: string | undefined): boolean {
  if (!lane) {
    return false;
  }
  return lane === NESTED_LANE || lane.startsWith(NESTED_LANE_PREFIX);
}
