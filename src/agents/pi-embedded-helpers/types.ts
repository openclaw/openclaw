export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason =
  | "unknown_model"
  | "auth"
  | "not_found"
  | "rate_limit"
  | "server"
  | "timeout"
  | "transport"
  | "billing"
  | "bad_request"
  | "policy"
  | "cancelled"
  | "format"
  | "unknown";

export const FALLBACK_TRIGGER_REASONS: ReadonlySet<FailoverReason> = new Set([
  "unknown_model",
  "auth",
  "not_found",
  "rate_limit",
  "server",
  "timeout",
  "transport",
  "billing",
  "unknown",
]);

export const FAIL_FAST_REASONS: ReadonlySet<FailoverReason> = new Set([
  "bad_request",
  "policy",
  "cancelled",
  "format",
]);

export function shouldTriggerFallback(reason: FailoverReason | null | undefined): boolean {
  return Boolean(reason && FALLBACK_TRIGGER_REASONS.has(reason));
}
