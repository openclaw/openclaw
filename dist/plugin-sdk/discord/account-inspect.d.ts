import type { OpenClawConfig } from "../config/config.js";
import type { DiscordAccountConfig } from "../config/types.discord.js";
export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";
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
