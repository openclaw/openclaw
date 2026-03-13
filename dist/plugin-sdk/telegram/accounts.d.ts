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
/** @internal Reset the once-per-process warning flag. Exported for tests only. */
export declare function resetMissingDefaultWarnFlag(): void;
export declare function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string;
export declare function resolveTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig | undefined;
export declare function mergeTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig;
export declare function createTelegramActionGate(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean;
export type TelegramPollActionGateState = {
    sendMessageEnabled: boolean;
    pollEnabled: boolean;
    enabled: boolean;
};
export declare function resolveTelegramPollActionGateState(isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean): TelegramPollActionGateState;
export declare function resolveTelegramAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedTelegramAccount;
export declare function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[];
