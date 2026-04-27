export const AGENT_LANE_NESTED = "nested" /* CommandLane.Nested */;
export const AGENT_LANE_SUBAGENT = "subagent" /* CommandLane.Subagent */;
const NESTED_LANE = "nested";
const NESTED_LANE_PREFIX = `${NESTED_LANE}:`;
export function resolveNestedAgentLane(lane) {
    const trimmed = lane?.trim();
    // Nested agent runs should not inherit the cron execution lane. Cron jobs
    // already occupy that lane while they dispatch inner work.
    if (!trimmed || trimmed === "cron") {
        return AGENT_LANE_NESTED;
    }
    return trimmed;
}
export function resolveNestedAgentLaneForSession(sessionKey) {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
        return AGENT_LANE_NESTED;
    }
    return `${NESTED_LANE_PREFIX}${trimmed}`;
}
export function isNestedAgentLane(lane) {
    if (!lane) {
        return false;
    }
    return lane === NESTED_LANE || lane.startsWith(NESTED_LANE_PREFIX);
}
