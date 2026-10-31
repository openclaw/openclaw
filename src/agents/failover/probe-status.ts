import type { FailoverReason } from "./signal.js";

export const FAILOVER_PROBE_STATUS = {
  auth: "auth",
  auth_permanent: "auth",
  format: "format",
  rate_limit: "rate_limit",
  overloaded: "rate_limit",
  billing: "billing",
  server_error: "unknown",
  timeout: "timeout",
  tls_certificate: "unknown",
  context_overflow: "unknown",
  model_not_found: "format",
  session_expired: "unknown",
  empty_response: "unknown",
  no_error_details: "unknown",
  unclassified: "unknown",
  unknown: "unknown",
} as const satisfies Record<FailoverReason, string>;
