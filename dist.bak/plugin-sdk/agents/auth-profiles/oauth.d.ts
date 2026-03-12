import { type OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";
type ResolveApiKeyForProfileParams = {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
};
export declare function resolveApiKeyForProfile(params: ResolveApiKeyForProfileParams): Promise<{
    apiKey: string;
    provider: string;
    email?: string;
} | null>;
export {};
