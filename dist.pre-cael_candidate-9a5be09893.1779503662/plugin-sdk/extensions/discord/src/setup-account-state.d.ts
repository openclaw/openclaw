import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "./runtime-api.js";
type InspectedDiscordSetupAccount = {
    accountId: string;
    enabled: boolean;
    token: string;
    tokenSource: "env" | "config" | "none";
    tokenStatus: "available" | "configured_unavailable" | "missing";
    configured: boolean;
    config: DiscordAccountConfig;
};
export declare function listDiscordSetupAccountIds(cfg: OpenClawConfig): string[];
export declare function resolveDefaultDiscordSetupAccountId(cfg: OpenClawConfig): string;
export declare function resolveDiscordSetupAccountConfig(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): {
    accountId: string;
    config: DiscordAccountConfig;
};
export declare function inspectDiscordSetupAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): InspectedDiscordSetupAccount;
export {};
