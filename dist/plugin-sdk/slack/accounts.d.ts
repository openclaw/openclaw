import type { OpenClawConfig } from "../config/config.js";
import type { SlackAccountConfig } from "../config/types.js";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
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
export declare const listSlackAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultSlackAccountId: (cfg: OpenClawConfig) => string;
export declare function mergeSlackAccountConfig(cfg: OpenClawConfig, accountId: string): SlackAccountConfig;
export declare function resolveSlackAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedSlackAccount;
export declare function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[];
export declare function resolveSlackReplyToMode(account: ResolvedSlackAccount, chatType?: string | null): "off" | "first" | "all";
