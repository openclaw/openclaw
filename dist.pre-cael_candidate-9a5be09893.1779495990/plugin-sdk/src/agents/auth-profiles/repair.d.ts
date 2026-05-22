import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileIdRepairResult, AuthProfileStore } from "./types.js";
export declare function suggestOAuthProfileIdForLegacyDefault(params: {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    provider: string;
    legacyProfileId: string;
}): string | null;
export declare function repairOAuthProfileIdMismatch(params: {
    cfg: OpenClawConfig;
    store: AuthProfileStore;
    provider: string;
    legacyProfileId?: string;
}): AuthProfileIdRepairResult;
