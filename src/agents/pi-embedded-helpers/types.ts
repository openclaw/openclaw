export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";

export type ErrorKind =
  | "billing"
  | "rate_limit"
  | "timeout"
  | "auth"
  | "auth_permanent"
  | "context_overflow"
  | "overloaded"
  | "format"
  | "compaction_failure"
  | "role_ordering"
  | "image_size"
  | "model_not_found"
  | "session_expired"
  | "unknown";
