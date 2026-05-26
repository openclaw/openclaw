//#region src/agents/lanes.ts
const AGENT_LANE_NESTED = "nested";
const AGENT_LANE_CRON_NESTED = "cron-nested";
const AGENT_LANE_SUBAGENT = "subagent";
const AGENT_LANE_CRON = "cron";
const NESTED_LANE = "nested";
const NESTED_LANE_PREFIX = `${NESTED_LANE}:`;
function resolveCronAgentLane(lane) {
	const trimmed = lane?.trim();
	if (!trimmed || trimmed === AGENT_LANE_CRON) return AGENT_LANE_CRON_NESTED;
	return trimmed;
}
function resolveNestedAgentLaneForSession(sessionKey) {
	const trimmed = sessionKey?.trim();
	if (!trimmed) return AGENT_LANE_NESTED;
	return `${NESTED_LANE_PREFIX}${trimmed}`;
}
function isNestedAgentLane(lane) {
	if (!lane) return false;
	return lane === NESTED_LANE || lane.startsWith(NESTED_LANE_PREFIX);
}
//#endregion
export { resolveNestedAgentLaneForSession as i, isNestedAgentLane as n, resolveCronAgentLane as r, AGENT_LANE_SUBAGENT as t };
