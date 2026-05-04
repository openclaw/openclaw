import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs and transport timeouts should not poison shared provider auth health.
  // `format` errors (HTTP 422 / "invalid request format") originate from a malformed
  // payload we sent — they reflect a client-side bug, not provider auth health, so
  // cooling down the profile would block sibling models that share it without cause.
  // shouldPreserveTransientCooldownProbeSlot in failover-policy.ts already classifies
  // `format` alongside auth/permanent reasons; this mirrors that classification here.
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
