import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";
export declare function resolveAuthProfileDisplayLabel(params: {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    profileId: string;
}): string;
