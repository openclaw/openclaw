//#region src/channels/plugins/dm-access.d.ts
type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";
type ChannelDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type ChannelDmAccess = {
  dmPolicy?: ChannelDmPolicy;
  allowFrom?: Array<string | number>;
};
type DmAccessRecord = Record<string, unknown>;
type CompatMutationResult = {
  entry: DmAccessRecord;
  changed: boolean;
};
declare function normalizeChannelDmPolicy(value: string | undefined): ChannelDmPolicy | undefined;
declare function resolveChannelDmPolicy(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
  defaultPolicy?: string;
}): ChannelDmPolicy | undefined;
declare function resolveChannelDmAllowFrom(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
}): Array<string | number> | undefined;
declare function resolveChannelDmAccess(params: {
  account?: DmAccessRecord | null;
  parent?: DmAccessRecord | null;
  mode?: ChannelDmAllowFromMode;
  defaultPolicy?: string;
}): ChannelDmAccess;
declare function setCanonicalDmAllowFrom(params: {
  entry: DmAccessRecord;
  mode: ChannelDmAllowFromMode;
  allowFrom: Array<string | number>;
  pathPrefix: string;
  changes?: string[];
  reason: string;
}): void;
declare function normalizeLegacyDmAliases(params: {
  entry: DmAccessRecord;
  pathPrefix: string;
  changes: string[];
  promoteAllowFrom?: boolean;
}): CompatMutationResult;
declare function ensureOpenDmPolicyAllowFromWildcard(params: {
  entry: DmAccessRecord;
  mode: ChannelDmAllowFromMode;
  pathPrefix: string;
  changes: string[];
}): void;
//#endregion
export { DmAccessRecord as a, normalizeLegacyDmAliases as c, resolveChannelDmPolicy as d, setCanonicalDmAllowFrom as f, CompatMutationResult as i, resolveChannelDmAccess as l, ChannelDmAllowFromMode as n, ensureOpenDmPolicyAllowFromWildcard as o, ChannelDmPolicy as r, normalizeChannelDmPolicy as s, ChannelDmAccess as t, resolveChannelDmAllowFrom as u };