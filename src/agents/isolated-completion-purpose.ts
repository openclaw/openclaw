/** Bounded internal diagnostic labels, independent of execution policy triggers. */
export type IsolatedCompletionPurpose =
  | "isolated-completion"
  | "session-activity-summary"
  | "session-observer"
  | "conversation-label"
  | "composer-prediction"
  | "progress-narration"
  | "transcript-summary"
  | "plugin-completion";
