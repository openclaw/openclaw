import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs, transport timeouts, and request-format errors should
  // not poison shared provider auth health.  Format failures (e.g.
  // invalid_request_error due to a corrupted transcript) are request-specific
  // data issues, not indicators of provider unavailability.
  if (
    params.policy === "local" ||
    !params.failoverReason ||
    params.failoverReason === "timeout" ||
    params.failoverReason === "format"
  ) {
    return null;
  }
  return params.failoverReason;
}
