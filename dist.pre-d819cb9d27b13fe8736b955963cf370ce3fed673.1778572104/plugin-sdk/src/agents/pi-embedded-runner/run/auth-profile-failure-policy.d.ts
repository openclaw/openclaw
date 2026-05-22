import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
export declare function resolveAuthProfileFailureReason(params: {
    failoverReason: FailoverReason | null;
    policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null;
