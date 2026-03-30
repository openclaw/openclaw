import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";
export declare function formatAuthDoctorHint(params: {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    provider: string;
    profileId?: string;
}): string;
