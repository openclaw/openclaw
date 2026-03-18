import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";

/**
 * Map a failover reason to an auth-profile failure reason.
 *
 * Returns `null` for reasons that should NOT mark the auth profile as failed:
 * - `null` / missing: no failure to record.
 * - `"timeout"`: transport/model-path failure, not an auth health signal.
 * - `"overloaded"`: transient server-side capacity issue (HTTP 529). The
 *   profile itself is healthy; marking it as failed causes exponential
 *   cooldown escalation that outlasts the provider recovery.
 */
export function resolveAuthProfileFailureReason(
  failoverReason: FailoverReason | null,
): AuthProfileFailureReason | null {
  if (!failoverReason || failoverReason === "timeout" || failoverReason === "overloaded") {
    return null;
  }
  return failoverReason;
}
