import { type ChannelDmPolicy } from "openclaw/plugin-sdk/channel-config-helpers";
import type { DiscordAccountConfig, DiscordActionConfig, OpenClawConfig } from "./runtime-api.js";
import { type DiscordCredentialStatus } from "./token.js";
export type ResolvedDiscordAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    token: string;
    tokenSource: "env" | "config" | "none";
    tokenStatus: DiscordCredentialStatus;
    config: DiscordAccountConfig;
};
export declare const listDiscordAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultDiscordAccountId: (cfg: OpenClawConfig) => string;
export declare function resolveDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig | undefined;
export declare function mergeDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig;
export declare function resolveDiscordAccountAllowFrom(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[] | undefined;
export declare function resolveDiscordAccountDmPolicy(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ChannelDmPolicy | undefined;
export declare function createDiscordActionGate(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean;
export declare function resolveDiscordAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedDiscordAccount;
export declare function resolveDiscordMaxLinesPerMessage(params: {
    cfg: OpenClawConfig;
    discordConfig?: DiscordAccountConfig | null;
    accountId?: string | null;
}): number | undefined;
export declare function isDiscordAccountEnabledForRuntime(account: ResolvedDiscordAccount, cfg: OpenClawConfig): boolean;
export declare function resolveDiscordAccountDisabledReason(account: ResolvedDiscordAccount, cfg: OpenClawConfig): string;
export declare function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[];
