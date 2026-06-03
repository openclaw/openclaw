import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../embedded-agent-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

/**
 * Converts an attempt failover reason into the shared auth-profile health
 * reason, returning null for failures that are local to one run/session.
 */
export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  providerStarted?: boolean;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs, transport/server failures, empty responses, and request-shape ("format") rejections
  // should not poison shared provider auth health. A `format` failure means the
  // provider rejected the request payload (e.g. an assistant-prefill 400 from a
  // strict provider when a session transcript ends with a stream-error placeholder
  // turn) — that is a per-session transcript-shape problem, not a profile-wide
  // reliability signal. Cascading it to a profile cooldown blocks every other
  // healthy session sharing the same auth profile and, when all profiles share
  // the same fault, takes down the entire provider for the configured backoff
  // window (#77228).
  if (
    params.policy === "local" ||
    !params.failoverReason ||
    params.failoverReason === "server_error" ||
    params.failoverReason === "empty_response" ||
    params.failoverReason === "format"
  ) {
    return null;
  }
  if (params.failoverReason === "timeout" && params.providerStarted !== true) {
    // A timeout before provider dispatch means local setup stalled, not that
    // the selected auth profile failed a model request.
    return null;
  }
  return params.failoverReason;
}
