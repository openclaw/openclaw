import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function normalizeChannelTargetInput(raw: string): string;
declare function resetTargetNormalizerCacheForTests(): void;
export declare const __testing: {
    readonly resetTargetNormalizerCacheForTests: typeof resetTargetNormalizerCacheForTests;
};
export declare function normalizeTargetForProvider(provider: string, raw?: string): string | undefined;
export type TargetResolveKindLike = ChannelDirectoryEntryKind | "channel";
export type ResolvedPluginMessagingTarget = {
    to: string;
    kind: TargetResolveKindLike;
    display?: string;
    source: "normalized" | "directory";
};
export declare function resolveNormalizedTargetInput(provider: string, raw?: string): {
    raw: string;
    normalized: string;
} | undefined;
export declare function looksLikeTargetId(params: {
    channel: ChannelId;
    raw: string;
    normalized?: string;
}): boolean;
export declare function maybeResolvePluginMessagingTarget(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    input: string;
    accountId?: string | null;
    preferredKind?: TargetResolveKindLike;
    requireIdLike?: boolean;
}): Promise<ResolvedPluginMessagingTarget | undefined>;
export declare function buildTargetResolverSignature(channel: ChannelId): string;
export {};
