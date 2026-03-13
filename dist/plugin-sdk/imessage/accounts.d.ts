import type { OpenClawConfig } from "../config/config.js";
import type { IMessageAccountConfig } from "../config/types.js";
export type ResolvedIMessageAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    config: IMessageAccountConfig;
    configured: boolean;
};
export declare const listIMessageAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultIMessageAccountId: (cfg: OpenClawConfig) => string;
export declare function resolveIMessageAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedIMessageAccount;
export declare function listEnabledIMessageAccounts(cfg: OpenClawConfig): ResolvedIMessageAccount[];
