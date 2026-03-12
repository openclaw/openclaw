export type ChannelMatchSource = "direct" | "parent" | "wildcard";
export type ChannelEntryMatch<T> = {
    entry?: T;
    key?: string;
    wildcardEntry?: T;
    wildcardKey?: string;
    parentEntry?: T;
    parentKey?: string;
    matchKey?: string;
    matchSource?: ChannelMatchSource;
};
export declare function applyChannelMatchMeta<TResult extends {
    matchKey?: string;
    matchSource?: ChannelMatchSource;
}>(result: TResult, match: ChannelEntryMatch<unknown>): TResult;
export declare function resolveChannelMatchConfig<TEntry, TResult extends {
    matchKey?: string;
    matchSource?: ChannelMatchSource;
}>(match: ChannelEntryMatch<TEntry>, resolveEntry: (entry: TEntry) => TResult): TResult | null;
export declare function normalizeChannelSlug(value: string): string;
export declare function buildChannelKeyCandidates(...keys: Array<string | undefined | null>): string[];
export declare function resolveChannelEntryMatch<T>(params: {
    entries?: Record<string, T>;
    keys: string[];
    wildcardKey?: string;
}): ChannelEntryMatch<T>;
export declare function resolveChannelEntryMatchWithFallback<T>(params: {
    entries?: Record<string, T>;
    keys: string[];
    parentKeys?: string[];
    wildcardKey?: string;
    normalizeKey?: (value: string) => string;
}): ChannelEntryMatch<T>;
export declare function resolveNestedAllowlistDecision(params: {
    outerConfigured: boolean;
    outerMatched: boolean;
    innerConfigured: boolean;
    innerMatched: boolean;
}): boolean;
