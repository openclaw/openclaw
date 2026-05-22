export declare const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export declare const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export declare const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, cron, wake events.";
export declare const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions; filters/previews.";
export declare const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized session history.";
export declare const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Message session or configured agent.";
export declare const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn subagent or ACP session.";
export declare const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn subagent session.";
export declare const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status/model/usage.";
export declare const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track short work plan.";
export declare function describeSessionsListTool(): string;
export declare function describeSessionsHistoryTool(): string;
export declare function describeSessionsSendTool(): string;
export declare function describeSessionsSpawnTool(options?: {
    acpAvailable?: boolean;
    threadAvailable?: boolean;
}): string;
export declare function describeSessionStatusTool(): string;
export declare function describeUpdatePlanTool(): string;
