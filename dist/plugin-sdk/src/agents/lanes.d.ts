import { CommandLane } from "../process/lanes.js";
export declare const AGENT_LANE_NESTED = CommandLane.Nested;
export declare const AGENT_LANE_CRON_NESTED = CommandLane.CronNested;
export declare const AGENT_LANE_SUBAGENT = CommandLane.Subagent;
export declare function resolveNestedAgentLane(lane?: string): string;
export declare function resolveCronAgentLane(lane?: string): string;
export declare function resolveNestedAgentLaneForSession(sessionKey: string | undefined): string;
export declare function isNestedAgentLane(lane: string | undefined): boolean;
