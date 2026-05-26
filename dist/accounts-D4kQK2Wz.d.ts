import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { _ as TelegramAccountConfig, v as TelegramActionConfig } from "./types.channels-C67UBRPK.js";
import { t as TelegramTransport } from "./fetch-bI19k1Gs.js";

//#region extensions/telegram/src/account-config.d.ts
declare function resolveTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig | undefined;
declare function mergeTelegramAccountConfig(cfg: OpenClawConfig, accountId: string): TelegramAccountConfig;
//#endregion
//#region extensions/telegram/src/accounts.d.ts
type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};
type TelegramMediaRuntimeOptions = {
  token: string;
  transport?: TelegramTransport;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
};
declare function listTelegramAccountIds(cfg: OpenClawConfig): string[];
/** @internal Reset the once-per-process warning flag. Exported for tests only. */
declare function resetMissingDefaultWarnFlag(): void;
declare function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string;
declare function createTelegramActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean;
declare function resolveTelegramMediaRuntimeOptions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  token: string;
  transport?: TelegramTransport;
}): TelegramMediaRuntimeOptions;
type TelegramPollActionGateState = {
  sendMessageEnabled: boolean;
  pollEnabled: boolean;
  enabled: boolean;
};
declare function resolveTelegramPollActionGateState(isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean): TelegramPollActionGateState;
declare function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount;
declare function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[];
//#endregion
export { listEnabledTelegramAccounts as a, resolveDefaultTelegramAccountId as c, resolveTelegramPollActionGateState as d, mergeTelegramAccountConfig as f, createTelegramActionGate as i, resolveTelegramAccount as l, TelegramMediaRuntimeOptions as n, listTelegramAccountIds as o, resolveTelegramAccountConfig as p, TelegramPollActionGateState as r, resetMissingDefaultWarnFlag as s, ResolvedTelegramAccount as t, resolveTelegramMediaRuntimeOptions as u };