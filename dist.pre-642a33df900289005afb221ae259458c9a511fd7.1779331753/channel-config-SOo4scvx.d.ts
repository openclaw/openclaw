//#region src/channels/channel-config.d.ts
type ChannelMatchSource = "direct" | "parent" | "wildcard";
type ChannelEntryMatch<T> = {
  entry?: T;
  key?: string;
  wildcardEntry?: T;
  wildcardKey?: string;
  parentEntry?: T;
  parentKey?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};
declare function applyChannelMatchMeta<TResult extends {
  matchKey?: string;
  matchSource?: ChannelMatchSource;
}>(result: TResult, match: ChannelEntryMatch<unknown>): TResult;
declare function resolveChannelMatchConfig<TEntry, TResult extends {
  matchKey?: string;
  matchSource?: ChannelMatchSource;
}>(match: ChannelEntryMatch<TEntry>, resolveEntry: (entry: TEntry) => TResult): TResult | null;
declare function normalizeChannelSlug(value: string): string;
declare function buildChannelKeyCandidates(...keys: Array<string | undefined | null>): string[];
declare function resolveChannelEntryMatch<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T>;
declare function resolveChannelEntryMatchWithFallback<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  parentKeys?: string[];
  wildcardKey?: string;
  normalizeKey?: (value: string) => string;
}): ChannelEntryMatch<T>;
declare function resolveNestedAllowlistDecision(params: {
  outerConfigured: boolean;
  outerMatched: boolean;
  innerConfigured: boolean;
  innerMatched: boolean;
}): boolean;
//#endregion
export { normalizeChannelSlug as a, resolveChannelMatchConfig as c, buildChannelKeyCandidates as i, resolveNestedAllowlistDecision as l, ChannelMatchSource as n, resolveChannelEntryMatch as o, applyChannelMatchMeta as r, resolveChannelEntryMatchWithFallback as s, ChannelEntryMatch as t };