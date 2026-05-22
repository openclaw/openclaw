//#region src/channels/allowlist-match.d.ts
type AllowlistMatchSource = "wildcard" | "id" | "name" | "tag" | "username" | "prefixed-id" | "prefixed-user" | "prefixed-name" | "slug" | "localpart";
type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
};
type CompiledAllowlist = {
  set: ReadonlySet<string>;
  wildcard: boolean;
};
declare function formatAllowlistMatchMeta(match?: {
  matchKey?: string;
  matchSource?: string;
} | null): string;
declare function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist;
declare function resolveAllowlistCandidates<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{
    value?: string;
    source: TSource;
  }>;
}): AllowlistMatch<TSource>;
declare function resolveCompiledAllowlistMatch<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{
    value?: string;
    source: TSource;
  }>;
}): AllowlistMatch<TSource>;
declare function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: ReadonlyArray<string>;
  candidates: Array<{
    value?: string;
    source: TSource;
  }>;
}): AllowlistMatch<TSource>;
declare function resolveAllowlistMatchSimple(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name">;
//#endregion
export { formatAllowlistMatchMeta as a, resolveAllowlistMatchSimple as c, compileAllowlist as i, resolveCompiledAllowlistMatch as l, AllowlistMatchSource as n, resolveAllowlistCandidates as o, CompiledAllowlist as r, resolveAllowlistMatchByCandidates as s, AllowlistMatch as t };