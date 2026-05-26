import { type OpenClawConfig } from "../config/config.js";
import { type ProviderAuth } from "./provider-usage.auth.js";
import type { UsageProviderId, UsageSummary } from "./provider-usage.types.js";
type UsageSummaryOptions = {
    now?: number;
    timeoutMs?: number;
    providers?: UsageProviderId[];
    auth?: ProviderAuth[];
    agentDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    skipPluginAuthWithoutCredentialSource?: boolean;
};
export declare function loadProviderUsageSummary(opts?: UsageSummaryOptions): Promise<UsageSummary>;
export {};
