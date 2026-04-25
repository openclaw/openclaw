import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";

export type AuthProfileFailurePolicy = "shared" | "local";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  if (params.policy === "local" || !params.failoverReason || params.failoverReason === "timeout") {
    return null;
  }
  return params.failoverReason;
}
