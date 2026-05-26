import type { ChannelAllowlistAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type AllowlistConfigPaths = {
    readPaths: string[][];
    writePath: string[];
    cleanupPaths?: string[][];
};
export type AllowlistGroupOverride = {
    label: string;
    entries: string[];
};
export type AllowlistNameResolution = Array<{
    input: string;
    resolved: boolean;
    name?: string | null;
}>;
type AllowlistNormalizer = (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    values: Array<string | number>;
}) => string[];
type AllowlistAccountResolver<ResolvedAccount> = (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}) => ResolvedAccount;
export declare function resolveDmGroupAllowlistConfigPaths(scope: "dm" | "group"): AllowlistConfigPaths;
export declare function resolveLegacyDmAllowlistConfigPaths(scope: "dm" | "group"): AllowlistConfigPaths | null;
/** Coerce stored allowlist entries into presentable non-empty strings. */
export declare function readConfiguredAllowlistEntries(entries: Array<string | number> | null | undefined): string[];
/** Collect labeled allowlist overrides from a flat keyed record. */
export declare function collectAllowlistOverridesFromRecord<T>(params: {
    record: Record<string, T | undefined> | null | undefined;
    label: (key: string, value: T) => string;
    resolveEntries: (value: T) => Array<string | number> | null | undefined;
}): AllowlistGroupOverride[];
/** Collect labeled allowlist overrides from an outer record with nested child records. */
export declare function collectNestedAllowlistOverridesFromRecord<Outer, Inner>(params: {
    record: Record<string, Outer | undefined> | null | undefined;
    outerLabel: (key: string, value: Outer) => string;
    resolveOuterEntries: (value: Outer) => Array<string | number> | null | undefined;
    resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
    innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
    resolveInnerEntries: (value: Inner) => Array<string | number> | null | undefined;
}): AllowlistGroupOverride[];
/** Build an account-scoped flat override resolver from a keyed allowlist record. */
export declare function createFlatAllowlistOverrideResolver<ResolvedAccount, Entry>(params: {
    resolveRecord: (account: ResolvedAccount) => Record<string, Entry | undefined> | null | undefined;
    label: (key: string, value: Entry) => string;
    resolveEntries: (value: Entry) => Array<string | number> | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[];
/** Build an account-scoped nested override resolver from hierarchical allowlist records. */
export declare function createNestedAllowlistOverrideResolver<ResolvedAccount, Outer, Inner>(params: {
    resolveRecord: (account: ResolvedAccount) => Record<string, Outer | undefined> | null | undefined;
    outerLabel: (key: string, value: Outer) => string;
    resolveOuterEntries: (value: Outer) => Array<string | number> | null | undefined;
    resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
    innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
    resolveInnerEntries: (value: Inner) => Array<string | number> | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[];
/** Build the common account-scoped token-gated allowlist name resolver. */
export declare function createAccountScopedAllowlistNameResolver<ResolvedAccount>(params: {
    resolveAccount: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => ResolvedAccount;
    resolveToken: (account: ResolvedAccount) => string | null | undefined;
    resolveNames: (params: {
        token: string;
        entries: string[];
    }) => Promise<AllowlistNameResolution>;
}): NonNullable<ChannelAllowlistAdapter["resolveNames"]>;
/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
export declare function buildAccountScopedAllowlistConfigEditor(params: {
    channelId: ChannelId;
    normalize: AllowlistNormalizer;
    resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
}): NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]>;
/** Build the common DM/group allowlist adapter used by channels that store both lists in config. */
export declare function buildDmGroupAccountAllowlistAdapter<ResolvedAccount>(params: {
    channelId: ChannelId;
    resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
    normalize: AllowlistNormalizer;
    resolveDmAllowFrom: (account: ResolvedAccount, context: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Array<string | number> | null | undefined;
    resolveGroupAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
    resolveDmPolicy?: (account: ResolvedAccount) => string | null | undefined;
    resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
    resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit">;
/** Build the common DM-only allowlist adapter for channels with legacy dm.allowFrom fallback paths. */
export declare function buildLegacyDmAccountAllowlistAdapter<ResolvedAccount>(params: {
    channelId: ChannelId;
    resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
    normalize: AllowlistNormalizer;
    resolveDmAllowFrom: (account: ResolvedAccount, context: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Array<string | number> | null | undefined;
    resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
    resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit">;
export {};
