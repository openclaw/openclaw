import type { OpenClawConfig } from "../../config/types.js";
import type { DirectoryConfigParams } from "./directory-types.js";
import type { ChannelDirectoryEntry } from "./types.public.js";
export declare function applyDirectoryQueryAndLimit(ids: string[], params: {
    query?: string | null;
    limit?: number | null;
}): string[];
export declare function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[];
export declare function collectNormalizedDirectoryIds(params: {
    sources: Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
}): string[];
export declare function listDirectoryEntriesFromSources(params: {
    kind: "user" | "group";
    sources: Iterable<unknown>[];
    query?: string | null;
    limit?: number | null;
    normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listInspectedDirectoryEntriesFromSources<InspectedAccount>(params: DirectoryConfigParams & {
    kind: "user" | "group";
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => InspectedAccount | null | undefined;
    resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function createInspectedDirectoryEntriesLister<InspectedAccount>(params: {
    kind: "user" | "group";
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => InspectedAccount | null | undefined;
    resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
}): (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
export declare function listResolvedDirectoryEntriesFromSources<ResolvedAccount>(params: DirectoryConfigParams & {
    kind: "user" | "group";
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function createResolvedDirectoryEntriesLister<ResolvedAccount>(params: {
    kind: "user" | "group";
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
}): (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
export declare function listDirectoryUserEntriesFromAllowFrom(params: {
    allowFrom?: readonly unknown[];
    query?: string | null;
    limit?: number | null;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryUserEntriesFromAllowFromAndMapKeys(params: {
    allowFrom?: readonly unknown[];
    map?: Record<string, unknown>;
    query?: string | null;
    limit?: number | null;
    normalizeAllowFromId?: (entry: string) => string | null | undefined;
    normalizeMapKeyId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryGroupEntriesFromMapKeys(params: {
    groups?: Record<string, unknown>;
    query?: string | null;
    limit?: number | null;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params: {
    groups?: Record<string, unknown>;
    allowFrom?: readonly unknown[];
    query?: string | null;
    limit?: number | null;
    normalizeMapKeyId?: (entry: string) => string | null | undefined;
    normalizeAllowFromId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedAccount>(params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveAllowFrom: (account: ResolvedAccount) => readonly unknown[] | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedAccount>(params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveGroups: (account: ResolvedAccount) => Record<string, unknown> | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
