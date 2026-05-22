import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";
declare const listQaChannelAccountIds: (cfg: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig) => string[], resolveDefaultQaChannelAccountId: (cfg: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig) => string;
export { listQaChannelAccountIds, resolveDefaultQaChannelAccountId };
export declare function resolveQaChannelAccount(params: {
    cfg: CoreConfig;
    accountId?: string | null;
}): ResolvedQaChannelAccount;
export declare function listEnabledQaChannelAccounts(cfg: CoreConfig): ResolvedQaChannelAccount[];
export { DEFAULT_ACCOUNT_ID };
export type { ResolvedQaChannelAccount } from "./types.js";
