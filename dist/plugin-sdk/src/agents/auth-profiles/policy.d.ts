import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";
export declare function assertNoOAuthSecretRefPolicyViolations(params: {
    store: AuthProfileStore;
    cfg?: OpenClawConfig;
    profileIds?: Iterable<string>;
    context?: string;
}): void;
