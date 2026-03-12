import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";
export declare function resolveAuthProfileOrder(params: {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    provider: string;
    preferredProfile?: string;
}): string[];
