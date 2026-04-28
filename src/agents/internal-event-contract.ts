export const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION = "task_completion" as const;

export const MAX_AGENT_INTERNAL_EVENTS = 20;
export const MAX_AGENT_INTERNAL_EVENT_ID_CHARS = 512;
export const MAX_AGENT_INTERNAL_EVENT_LABEL_CHARS = 1024;
export const MAX_AGENT_INTERNAL_EVENT_RESULT_CHARS = 50_000;
export const MAX_AGENT_INTERNAL_EVENT_MEDIA_URLS = 32;
export const MAX_AGENT_INTERNAL_EVENT_MEDIA_URL_CHARS = 2048;
export const MAX_AGENT_INTERNAL_EVENT_STATS_LINE_CHARS = 2048;
export const MAX_AGENT_INTERNAL_EVENT_REPLY_INSTRUCTION_CHARS = 4096;

export const AGENT_INTERNAL_EVENT_SOURCES = [
  "subagent",
  "cron",
  "video_generation",
  "music_generation",
] as const;

export const AGENT_INTERNAL_EVENT_STATUSES = ["ok", "timeout", "error", "unknown"] as const;

export type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
export type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];
