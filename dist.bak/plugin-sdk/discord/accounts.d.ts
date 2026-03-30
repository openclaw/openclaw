import type { OpenClawConfig } from "../config/config.js";
import type { DiscordAccountConfig, DiscordActionConfig } from "../config/types.js";
export type ResolvedDiscordAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    token: string;
    tokenSource: "env" | "config" | "none";
    config: DiscordAccountConfig;
};
export declare const listDiscordAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultDiscordAccountId: (cfg: OpenClawConfig) => string;
export declare function createDiscordActionGate(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean;
export declare function resolveDiscordAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedDiscordAccount;
export declare function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[];
