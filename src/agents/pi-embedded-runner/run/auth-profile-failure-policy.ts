import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs and transport timeouts should not poison shared provider auth health.
  if (params.policy === "local" || !params.failoverReason || params.failoverReason === "timeout") {
    return null;
  }
  // `format` failures come from session-local request shape (e.g. malformed transcript,
  // empty messages array, schema mismatch). They are not provider auth/billing/rate health
  // signals, and putting the shared profile in cooldown over them blocks unrelated sessions
  // (#76829). The retry-limit policy already excludes `format` for the same reason; mirror
  // it here for shared profile health.
  if (params.failoverReason === "format") {
    return null;
  }
  return params.failoverReason;
}
