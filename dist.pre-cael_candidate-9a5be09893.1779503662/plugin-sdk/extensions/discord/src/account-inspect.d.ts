import type { DiscordAccountConfig, OpenClawConfig } from "./runtime-api.js";
import type { DiscordCredentialStatus } from "./token.js";
export type InspectedDiscordAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    token: string;
    tokenSource: "env" | "config" | "none";
    tokenStatus: DiscordCredentialStatus;
    configured: boolean;
    config: DiscordAccountConfig;
};
export declare function inspectDiscordAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    envToken?: string | null;
}): InspectedDiscordAccount;
