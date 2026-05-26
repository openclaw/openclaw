//#region src/infra/outbound/send-deps.d.ts
/**
 * Dynamic bag of per-channel send functions, keyed by channel ID.
 * Each outbound adapter resolves its own function from this record and
 * falls back to a direct import when the key is absent.
 */
type OutboundSendDeps = {
  [channelId: string]: unknown;
};
declare function resolveLegacyOutboundSendDepKeys(channelId: string): string[];
type ResolveOutboundSendDepOptions = {
  legacyKeys?: readonly string[];
};
declare function resolveOutboundSendDep<T>(deps: OutboundSendDeps | null | undefined, channelId: string, options?: ResolveOutboundSendDepOptions): T | undefined;
//#endregion
export { resolveOutboundSendDep as i, ResolveOutboundSendDepOptions as n, resolveLegacyOutboundSendDepKeys as r, OutboundSendDeps as t };