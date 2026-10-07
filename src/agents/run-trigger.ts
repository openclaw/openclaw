export type EmbeddedRunTrigger = "cron" | "event" | "manual" | "memory" | "overflow" | "user";

/** Bounded internal diagnostic labels, independent of execution policy triggers. */
export type IsolatedCompletionPurpose =
  | "isolated-completion"
  | "session-activity-summary"
  | "session-observer"
  | "conversation-label"
  | "progress-narration"
  | "transcript-summary"
  | "plugin-completion";
