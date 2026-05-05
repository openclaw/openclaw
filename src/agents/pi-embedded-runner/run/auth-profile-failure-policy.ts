import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Only signals that genuinely reflect auth-profile health should put a
  // profile into cooldown. Transport/payload/model-path failures are not
  // auth signals and must not punish the profile (otherwise a single
  // request-side bug — e.g. an Anthropic 400 "assistant message prefill"
  // schema rejection from one model — cascades into "all profiles
  // unavailable" across every fallback model on the same provider).
  if (params.policy === "local" || !params.failoverReason) {
    return null;
  }
  switch (params.failoverReason) {
    case "auth":
    case "auth_permanent":
    case "billing":
    case "rate_limit":
    case "session_expired":
      return params.failoverReason;
    // format          → client-side payload/schema bug, not profile fault
    // overloaded      → provider-wide capacity, not profile fault
    // timeout         → transport, not auth health signal
    // model_not_found → catalog/model issue, not profile fault
    // empty_response  → provider returned nothing usable, not auth fault
    // no_error_details → opaque server failure, ambiguous
    // unclassified    → couldn't classify, ambiguous
    // unknown         → too risky to penalize profile on ambiguous errors
    case "format":
    case "overloaded":
    case "timeout":
    case "model_not_found":
    case "empty_response":
    case "no_error_details":
    case "unclassified":
    case "unknown":
      return null;
    default: {
      // Exhaustiveness guard — fail closed (don't mark) for new reasons.
      const _exhaustive: never = params.failoverReason;
      void _exhaustive;
      return null;
    }
  }
}
