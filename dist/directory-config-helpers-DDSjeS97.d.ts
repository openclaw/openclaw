import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { u as ChannelDirectoryEntry } from "./types.core-BkmTlRzr.js";
import { t as DirectoryConfigParams } from "./directory-types-CFWi-cc7.js";

//#region src/channels/plugins/directory-config-helpers.d.ts
declare function applyDirectoryQueryAndLimit(ids: string[], params: {
  query?: string | null;
  limit?: number | null;
}): string[];
declare function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[];
declare function collectNormalizedDirectoryIds(params: {
  sources: Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): string[];
declare function listDirectoryEntriesFromSources(params: {
  kind: "user" | "group";
  sources: Iterable<unknown>[];
  query?: string | null;
  limit?: number | null;
  normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listInspectedDirectoryEntriesFromSources<InspectedAccount>(params: DirectoryConfigParams & {
  kind: "user" | "group";
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => InspectedAccount | null | undefined;
  resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function createInspectedDirectoryEntriesLister<InspectedAccount>(params: {
  kind: "user" | "group";
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => InspectedAccount | null | undefined;
  resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare function listResolvedDirectoryEntriesFromSources<ResolvedAccount>(params: DirectoryConfigParams & {
  kind: "user" | "group";
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function createResolvedDirectoryEntriesLister<ResolvedAccount>(params: {
  kind: "user" | "group";
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): (configParams: DirectoryConfigParams) => Promise<ChannelDirectoryEntry[]>;
declare function listDirectoryUserEntriesFromAllowFrom(params: {
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listDirectoryUserEntriesFromAllowFromAndMapKeys(params: {
  allowFrom?: readonly unknown[];
  map?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listDirectoryGroupEntriesFromMapKeys(params: {
  groups?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params: {
  groups?: Record<string, unknown>;
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedAccount>(params: DirectoryConfigParams & {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveAllowFrom: (account: ResolvedAccount) => readonly unknown[] | undefined;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
declare function listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedAccount>(params: DirectoryConfigParams & {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveGroups: (account: ResolvedAccount) => Record<string, unknown> | undefined;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
//#endregion
export { listDirectoryEntriesFromSources as a, listDirectoryUserEntriesFromAllowFrom as c, listResolvedDirectoryEntriesFromSources as d, listResolvedDirectoryGroupEntriesFromMapKeys as f, createResolvedDirectoryEntriesLister as i, listDirectoryUserEntriesFromAllowFromAndMapKeys as l, toDirectoryEntries as m, collectNormalizedDirectoryIds as n, listDirectoryGroupEntriesFromMapKeys as o, listResolvedDirectoryUserEntriesFromAllowFrom as p, createInspectedDirectoryEntriesLister as r, listDirectoryGroupEntriesFromMapKeysAndAllowFrom as s, applyDirectoryQueryAndLimit as t, listInspectedDirectoryEntriesFromSources as u };