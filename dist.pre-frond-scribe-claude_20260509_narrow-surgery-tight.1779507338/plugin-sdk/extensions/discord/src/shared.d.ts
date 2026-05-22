import { type ResolvedDiscordAccount } from "./accounts.js";
import { type ChannelPlugin } from "./channel-api.js";
import type { OpenClawConfig } from "./runtime-api.js";
export declare const discordConfigAdapter: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedDiscordAccount;
    inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    setAccountEnabled?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
    }) => OpenClawConfig;
    deleteAccount?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
    }) => OpenClawConfig;
    resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Array<string | number> | undefined;
    formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
    }) => string[];
    resolveDefaultTo?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => string | undefined;
};
export declare function createDiscordPluginBase(params: {
    setup: NonNullable<ChannelPlugin<ResolvedDiscordAccount>["setup"]>;
    setupWizard?: ChannelPlugin<ResolvedDiscordAccount>["setupWizard"];
}): Pick<ChannelPlugin<ResolvedDiscordAccount>, "id" | "meta" | "setupWizard" | "capabilities" | "commands" | "doctor" | "streaming" | "reload" | "configSchema" | "config" | "setup" | "messaging" | "security" | "secrets">;
