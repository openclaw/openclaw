export declare const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION: "task_completion";
export declare const AGENT_INTERNAL_EVENT_SOURCES: readonly ["subagent", "cron", "video_generation", "music_generation"];
export declare const AGENT_INTERNAL_EVENT_STATUSES: readonly ["ok", "timeout", "error", "unknown"];
export type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
export type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];
