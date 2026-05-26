import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as ChannelAccountSnapshot } from "./types.core-BkmTlRzr.js";

//#region src/channels/plugins/account-helpers.d.ts
declare function createAccountListHelpers(channelKey: string, options?: {
  normalizeAccountId?: (id: string) => string;
  allowUnlistedDefaultAccount?: boolean;
  implicitDefaultAccount?: {
    channelKeys?: readonly string[];
    envVars?: readonly string[];
  };
  hasImplicitDefaultAccount?: (cfg: OpenClawConfig) => boolean;
}): {
  listConfiguredAccountIds: (cfg: OpenClawConfig) => string[];
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
};
declare function hasConfiguredAccountValue(value: unknown): boolean;
declare function listCombinedAccountIds(params: {
  configuredAccountIds: Iterable<string>;
  additionalAccountIds?: Iterable<string>;
  implicitAccountId?: string | undefined;
  fallbackAccountIdWhenEmpty?: string | undefined;
}): string[];
declare function resolveListedDefaultAccountId(params: {
  accountIds: readonly string[];
  configuredDefaultAccountId?: string | undefined;
  allowUnlistedDefaultAccount?: boolean;
  ambiguousFallbackAccountId?: string | undefined;
  normalizeListedAccountId?: ((accountId: string) => string) | undefined;
}): string;
declare function mergeAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accountConfig: Partial<TConfig> | undefined;
  omitKeys?: string[];
  nestedObjectKeys?: string[];
}): TConfig;
declare function resolveMergedAccountConfig<TConfig extends Record<string, unknown>>(params: {
  channelConfig: TConfig | undefined;
  accounts: Record<string, Partial<TConfig>> | undefined;
  accountId: string;
  omitKeys?: string[];
  normalizeAccountId?: (accountId: string) => string;
  nestedObjectKeys?: string[];
}): TConfig;
type AccountSnapshotInput = {
  accountId?: string | null;
  enabled?: boolean | null;
  name?: string | null | undefined;
};
declare function describeAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot;
declare function describeWebhookAccountSnapshot(params: {
  account: AccountSnapshotInput;
  configured?: boolean | undefined;
  mode?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot;
//#endregion
export { listCombinedAccountIds as a, resolveMergedAccountConfig as c, hasConfiguredAccountValue as i, describeAccountSnapshot as n, mergeAccountConfig as o, describeWebhookAccountSnapshot as r, resolveListedDefaultAccountId as s, createAccountListHelpers as t };