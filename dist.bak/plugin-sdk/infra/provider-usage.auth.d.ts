import type { UsageProviderId } from "./provider-usage.types.js";
export type ProviderAuth = {
    provider: UsageProviderId;
    token: string;
    accountId?: string;
};
export declare function resolveProviderAuths(params: {
    providers: UsageProviderId[];
    auth?: ProviderAuth[];
    agentDir?: string;
}): Promise<ProviderAuth[]>;
