/**
 * Dynamic bag of per-channel send functions, keyed by channel ID.
 * Each outbound adapter resolves its own function from this record and
 * falls back to a direct import when the key is absent.
 */
export type OutboundSendDeps = {
    [channelId: string]: unknown;
};
export declare function resolveLegacyOutboundSendDepKeys(channelId: string): string[];
export type ResolveOutboundSendDepOptions = {
    legacyKeys?: readonly string[];
};
export declare function resolveOutboundSendDep<T>(deps: OutboundSendDeps | null | undefined, channelId: string, options?: ResolveOutboundSendDepOptions): T | undefined;
