import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../failover/signal.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

/**
 * Returns the subset of failover reasons that should affect shared auth-profile
 * health. Local helper failures and request-shape/transport outcomes stay
 * session-local so one bad transcript or connection does not cool down an
 * otherwise healthy provider profile.
 */
export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  providerStarted?: boolean;
  transientRateLimit?: boolean;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // A rejected transcript is session-local; cooling its profile can block every
  // healthy session sharing that credential (#77228).
  if (
    params.policy === "local" ||
    !params.failoverReason ||
    // Provider-scoped overload must not cool one credential (#121341 classification).
    // Preserve #121278 credential scoping by rotating without a profile-health write.
    params.failoverReason === "overloaded" ||
    (params.policy === "local_transient" &&
      params.failoverReason === "rate_limit" &&
      params.transientRateLimit === true) ||
    params.failoverReason === "server_error" ||
    params.failoverReason === "tls_certificate" ||
    params.failoverReason === "empty_response" ||
    params.failoverReason === "context_overflow" ||
    params.failoverReason === "format"
  ) {
    return null;
  }
  if (params.failoverReason === "timeout" && params.providerStarted !== true) {
    return null;
  }
  return params.failoverReason;
}
