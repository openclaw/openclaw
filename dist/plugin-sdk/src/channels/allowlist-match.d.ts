export type AllowlistMatchSource = "wildcard" | "id" | "name" | "tag" | "username" | "prefixed-id" | "prefixed-user" | "prefixed-name" | "slug" | "localpart";
export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
    allowed: boolean;
    matchKey?: string;
    matchSource?: TSource;
};
export type CompiledAllowlist = {
    set: ReadonlySet<string>;
    wildcard: boolean;
};
export declare function formatAllowlistMatchMeta(match?: {
    matchKey?: string;
    matchSource?: string;
} | null): string;
export declare function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist;
export declare function resolveAllowlistCandidates<TSource extends string>(params: {
    compiledAllowlist: CompiledAllowlist;
    candidates: Array<{
        value?: string;
        source: TSource;
    }>;
}): AllowlistMatch<TSource>;
export declare function resolveCompiledAllowlistMatch<TSource extends string>(params: {
    compiledAllowlist: CompiledAllowlist;
    candidates: Array<{
        value?: string;
        source: TSource;
    }>;
}): AllowlistMatch<TSource>;
export declare function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
    allowList: ReadonlyArray<string>;
    candidates: Array<{
        value?: string;
        source: TSource;
    }>;
}): AllowlistMatch<TSource>;
export declare function resolveAllowlistMatchSimple(params: {
    allowFrom: ReadonlyArray<string | number>;
    senderId: string;
    senderName?: string | null;
    allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name">;
