import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelAccountSnapshot } from "./types.core.js";
export declare function createAccountListHelpers(channelKey: string, options?: {
    normalizeAccountId?: (id: string) => string;
    allowUnlistedDefaultAccount?: boolean;
}): {
    listConfiguredAccountIds: (cfg: OpenClawConfig) => string[];
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
};
export declare function listCombinedAccountIds(params: {
    configuredAccountIds: Iterable<string>;
    additionalAccountIds?: Iterable<string>;
    implicitAccountId?: string | undefined;
    fallbackAccountIdWhenEmpty?: string | undefined;
}): string[];
export declare function resolveListedDefaultAccountId(params: {
    accountIds: readonly string[];
    configuredDefaultAccountId?: string | undefined;
    allowUnlistedDefaultAccount?: boolean;
    ambiguousFallbackAccountId?: string | undefined;
    normalizeListedAccountId?: ((accountId: string) => string) | undefined;
}): string;
export declare function mergeAccountConfig<TConfig extends Record<string, unknown>>(params: {
    channelConfig: TConfig | undefined;
    accountConfig: Partial<TConfig> | undefined;
    omitKeys?: string[];
    nestedObjectKeys?: string[];
}): TConfig;
export declare function resolveMergedAccountConfig<TConfig extends Record<string, unknown>>(params: {
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
export declare function describeAccountSnapshot(params: {
    account: AccountSnapshotInput;
    configured?: boolean | undefined;
    extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot;
export declare function describeWebhookAccountSnapshot(params: {
    account: AccountSnapshotInput;
    configured?: boolean | undefined;
    mode?: string | undefined;
    extra?: Record<string, unknown> | undefined;
}): ChannelAccountSnapshot;
export {};
