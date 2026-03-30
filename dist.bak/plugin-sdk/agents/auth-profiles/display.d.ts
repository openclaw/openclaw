import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";
export declare function resolveAuthProfileDisplayLabel(params: {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    profileId: string;
}): string;
