import type { RuntimeEnv } from "../../runtime.js";
export type AllowlistUserResolutionLike = {
    input: string;
    resolved: boolean;
    id?: string;
};
export declare function mergeAllowlist(params: {
    existing?: Array<string | number>;
    additions: string[];
}): string[];
export declare function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(resolvedUsers: T[], opts?: {
    formatResolved?: (entry: T) => string;
}): {
    resolvedMap: Map<string, T>;
    mapping: string[];
    unresolved: string[];
    additions: string[];
};
export declare function resolveAllowlistIdAdditions<T extends AllowlistUserResolutionLike>(params: {
    existing: Array<string | number>;
    resolvedMap: Map<string, T>;
}): string[];
export declare function canonicalizeAllowlistWithResolvedIds<T extends AllowlistUserResolutionLike>(params: {
    existing?: Array<string | number>;
    resolvedMap: Map<string, T>;
}): string[];
export declare function patchAllowlistUsersInConfigEntries<T extends AllowlistUserResolutionLike, TEntries extends Record<string, unknown>>(params: {
    entries: TEntries;
    resolvedMap: Map<string, T>;
    strategy?: "merge" | "canonicalize";
}): TEntries;
export declare function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void;
export declare function summarizeMapping(label: string, mapping: string[], unresolved: string[], runtime: RuntimeEnv): void;
