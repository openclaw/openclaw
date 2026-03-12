import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig, TelegramActionConfig } from "../config/types.js";
export type ResolvedTelegramAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    token: string;
    tokenSource: "env" | "tokenFile" | "config" | "none";
    config: TelegramAccountConfig;
};
export declare function listTelegramAccountIds(cfg: OpenClawConfig): string[];
export declare function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string;
export declare function createTelegramActionGate(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean;
export declare function resolveTelegramAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedTelegramAccount;
export declare function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[];
