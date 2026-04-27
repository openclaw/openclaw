import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";
type OAuthSecretRefPolicyViolation = {
    profileId: string;
    path: string;
    reason: string;
};
export declare function collectOAuthSecretRefPolicyViolations(params: {
    store: AuthProfileStore;
    cfg?: OpenClawConfig;
    profileIds?: Iterable<string>;
}): OAuthSecretRefPolicyViolation[];
export declare function assertNoOAuthSecretRefPolicyViolations(params: {
    store: AuthProfileStore;
    cfg?: OpenClawConfig;
    profileIds?: Iterable<string>;
    context?: string;
}): void;
export {};
