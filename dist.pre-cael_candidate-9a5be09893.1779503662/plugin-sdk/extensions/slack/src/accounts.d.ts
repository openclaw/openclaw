import { type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { type ChannelDmPolicy } from "openclaw/plugin-sdk/channel-config-helpers";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
export { resolveSlackReplyToMode } from "./account-reply-mode.js";
export type SlackTokenSource = "env" | "config" | "none";
export type ResolvedSlackAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    botToken?: string;
    appToken?: string;
    userToken?: string;
    botTokenSource: SlackTokenSource;
    appTokenSource: SlackTokenSource;
    userTokenSource: SlackTokenSource;
    config: SlackAccountConfig;
} & SlackAccountSurfaceFields;
export type SlackConfigAccessorAccount = {
    allowFrom: string[] | undefined;
    defaultTo: string | undefined;
};
export declare const listSlackAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultSlackAccountId: (cfg: OpenClawConfig) => string;
export declare function mergeSlackAccountConfig(cfg: OpenClawConfig, accountId: string): SlackAccountConfig;
export declare function resolveSlackAccountAllowFrom(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[] | undefined;
export declare function resolveSlackConfigAccessorAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): SlackConfigAccessorAccount;
export declare function resolveSlackAccountDmPolicy(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ChannelDmPolicy | undefined;
export declare function resolveSlackAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedSlackAccount;
export declare function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[];
