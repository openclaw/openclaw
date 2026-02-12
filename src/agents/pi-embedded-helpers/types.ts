export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason =
  | "auth"
  | "format"
  | "not_found"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "unknown";
