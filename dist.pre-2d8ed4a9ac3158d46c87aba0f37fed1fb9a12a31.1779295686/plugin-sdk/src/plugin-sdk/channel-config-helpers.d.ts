import { type ConfigWriteAuthorizationResultLike, type ConfigWriteScopeLike, type ConfigWriteTargetLike } from "../channels/plugins/config-write-policy-shared.js";
import { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export { ensureOpenDmPolicyAllowFromWildcard, normalizeChannelDmPolicy, normalizeLegacyDmAliases, resolveChannelDmAccess, resolveChannelDmAllowFrom, resolveChannelDmPolicy, setCanonicalDmAllowFrom, type ChannelDmAccess, type ChannelDmAllowFromMode, type ChannelDmPolicy, type DmAccessRecord, } from "../channels/plugins/dm-access.js";
export type ConfigWriteScope = ConfigWriteScopeLike;
export type ConfigWriteTarget = ConfigWriteTargetLike;
export type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike;
type ChannelCrudConfigAdapter<ResolvedAccount> = Pick<ChannelConfigAdapter<ResolvedAccount>, "listAccountIds" | "resolveAccount" | "inspectAccount" | "defaultAccountId" | "setAccountEnabled" | "deleteAccount">;
type ChannelConfigAdapterWithAccessors<ResolvedAccount> = Pick<ChannelConfigAdapter<ResolvedAccount>, "listAccountIds" | "resolveAccount" | "inspectAccount" | "defaultAccountId" | "setAccountEnabled" | "deleteAccount" | "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo">;
export declare function resolveChannelConfigWrites(params: {
    cfg: OpenClawConfig;
    channelId?: string | null;
    accountId?: string | null;
}): boolean;
export declare function authorizeConfigWrite(params: {
    cfg: OpenClawConfig;
    origin?: ConfigWriteScope;
    target?: ConfigWriteTarget;
    allowBypass?: boolean;
}): ConfigWriteAuthorizationResult;
export declare function canBypassConfigWritePolicy(params: {
    channel?: string | null;
    gatewayClientScopes?: string[] | null;
}): boolean;
export declare function formatConfigWriteDeniedMessage(params: {
    result: Exclude<ConfigWriteAuthorizationResult, {
        allowed: true;
    }>;
    fallbackChannelId?: string | null;
}): string;
type ChannelConfigAccessorParams<Config extends OpenClawConfig = OpenClawConfig> = {
    cfg: Config;
    accountId?: string | null;
};
type MultiAccountChannelConfigAdapterParams<ResolvedAccount, AccessorAccount = ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig> = {
    sectionKey: string;
    listAccountIds: (cfg: Config) => string[];
    resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
    resolveAccessorAccount?: (params: ChannelConfigAccessorParams<Config>) => AccessorAccount;
    defaultAccountId: (cfg: Config) => string;
    inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
    clearBaseFields: string[];
    resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
    formatAllowFrom: (allowFrom: Array<string | number>) => string[];
    resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
};
type NamedAccountChannelConfigBaseParams<ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig> = {
    sectionKey: string;
    listAccountIds: (cfg: Config) => string[];
    resolveAccount: (cfg: Config, accountId?: string | null) => ResolvedAccount;
    defaultAccountId: (cfg: Config) => string;
    inspectAccount?: (cfg: Config, accountId?: string | null) => unknown;
    clearBaseFields: string[];
};
/** Coerce mixed allowlist config values into plain strings without trimming or deduping. */
export declare function mapAllowFromEntries(allowFrom: Array<string | number> | null | undefined): string[];
/** Normalize user-facing allowlist entries the same way config and doctor flows expect. */
export declare function formatTrimmedAllowFromEntries(allowFrom: Array<string | number>): string[];
/** Collapse nullable config scalars into a trimmed optional string. */
export declare function resolveOptionalConfigString(value: string | number | null | undefined): string | undefined;
/** Adapt `{ cfg, accountId }` accessors to callback sites that pass positional args. */
export declare function adaptScopedAccountAccessor<Result, Config extends OpenClawConfig = OpenClawConfig>(accessor: (params: {
    cfg: Config;
    accountId?: string | null;
}) => Result): (cfg: Config, accountId?: string | null) => Result;
/** Build the shared allowlist/default target adapter surface for account-scoped channel configs. */
export declare function createScopedAccountConfigAccessors<ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: {
    resolveAccount: (params: {
        cfg: Config;
        accountId?: string | null;
    }) => ResolvedAccount;
    resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
    formatAllowFrom: (allowFrom: Array<string | number>) => string[];
    resolveDefaultTo?: (account: ResolvedAccount) => string | number | null | undefined;
}): Pick<ChannelConfigAdapter<ResolvedAccount>, "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo">;
/** Build the common CRUD/config helpers for channels that store multiple named accounts. */
export declare function createScopedChannelConfigBase<ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: NamedAccountChannelConfigBaseParams<ResolvedAccount, Config> & {
    allowTopLevel?: boolean;
}): ChannelCrudConfigAdapter<ResolvedAccount>;
/** Build the full shared config adapter for account-scoped channels with allowlist/default target accessors. */
export declare function createScopedChannelConfigAdapter<ResolvedAccount, AccessorAccount = ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: MultiAccountChannelConfigAdapterParams<ResolvedAccount, AccessorAccount, Config> & {
    allowTopLevel?: boolean;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount>;
/** Build CRUD/config helpers for top-level single-account channels. */
export declare function createTopLevelChannelConfigBase<ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: {
    sectionKey: string;
    resolveAccount: (cfg: Config) => ResolvedAccount;
    listAccountIds?: (cfg: Config) => string[];
    defaultAccountId?: (cfg: Config) => string;
    inspectAccount?: (cfg: Config) => unknown;
    deleteMode?: "remove-section" | "clear-fields";
    clearBaseFields?: string[];
}): Pick<ChannelConfigAdapter<ResolvedAccount>, "listAccountIds" | "resolveAccount" | "inspectAccount" | "defaultAccountId" | "setAccountEnabled" | "deleteAccount">;
/** Build the full shared config adapter for top-level single-account channels with allowlist/default target accessors. */
export declare function createTopLevelChannelConfigAdapter<ResolvedAccount, AccessorAccount = ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: {
    sectionKey: string;
    resolveAccount: (cfg: Config) => ResolvedAccount;
    resolveAccessorAccount?: (params: {
        cfg: Config;
        accountId?: string | null;
    }) => AccessorAccount;
    listAccountIds?: (cfg: Config) => string[];
    defaultAccountId?: (cfg: Config) => string;
    inspectAccount?: (cfg: Config) => unknown;
    deleteMode?: "remove-section" | "clear-fields";
    clearBaseFields?: string[];
    resolveAllowFrom: (account: AccessorAccount) => Array<string | number> | null | undefined;
    formatAllowFrom: (allowFrom: Array<string | number>) => string[];
    resolveDefaultTo?: (account: AccessorAccount) => string | number | null | undefined;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount>;
/** Build CRUD/config helpers for channels where the default account lives at channel root and named accounts live under `accounts`. */
export declare function createHybridChannelConfigBase<ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: NamedAccountChannelConfigBaseParams<ResolvedAccount, Config> & {
    preserveSectionOnDefaultDelete?: boolean;
}): ChannelCrudConfigAdapter<ResolvedAccount>;
/** Build the full shared config adapter for hybrid channels with allowlist/default target accessors. */
export declare function createHybridChannelConfigAdapter<ResolvedAccount, AccessorAccount = ResolvedAccount, Config extends OpenClawConfig = OpenClawConfig>(params: MultiAccountChannelConfigAdapterParams<ResolvedAccount, AccessorAccount, Config> & {
    preserveSectionOnDefaultDelete?: boolean;
}): ChannelConfigAdapterWithAccessors<ResolvedAccount>;
/** Convert account-specific DM security fields into the shared runtime policy resolver shape. */
export declare function createScopedDmSecurityResolver<ResolvedAccount extends {
    accountId?: string | null;
}>(params: {
    channelKey: string;
    resolvePolicy: (account: ResolvedAccount) => string | null | undefined;
    resolveAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
    resolveAccess?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        account: ResolvedAccount;
    }) => {
        dmPolicy?: string | null;
        allowFrom?: Array<string | number> | null;
    };
    resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
    defaultPolicy?: string;
    allowFromPathSuffix?: string;
    policyPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
    inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ({ cfg, accountId, account, }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedAccount;
}) => import("./channel-runtime.ts").ChannelSecurityDmPolicy;
export { buildAccountScopedDmSecurityPolicy };
