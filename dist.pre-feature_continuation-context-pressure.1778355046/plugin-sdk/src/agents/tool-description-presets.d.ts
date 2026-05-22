export declare const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell commands that start now.";
export declare const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect and control running exec sessions.";
export declare const CRON_TOOL_DISPLAY_SUMMARY = "Schedule cron jobs, reminders, and wake events.";
export declare const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions with mailbox filters and optional previews.";
export declare const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized message history for a visible session.";
export declare const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Send a message to another visible session.";
export declare const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent or ACP sessions.";
export declare const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent sessions.";
export declare const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status, usage, and model state.";
export declare const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track a short structured work plan.";
export declare function describeSessionsListTool(): string;
export declare function describeSessionsHistoryTool(): string;
export declare function describeSessionsSendTool(): string;
export declare function describeSessionsSpawnTool(options?: {
    acpAvailable?: boolean;
    threadAvailable?: boolean;
}): string;
export declare function describeSessionStatusTool(): string;
export declare function describeUpdatePlanTool(): string;
