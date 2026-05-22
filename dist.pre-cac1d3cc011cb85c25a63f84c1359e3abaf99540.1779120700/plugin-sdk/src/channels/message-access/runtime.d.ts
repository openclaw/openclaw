import type { PairingChannel } from "../../pairing/pairing-store.types.js";
import type { ChannelIngressRouteDescriptor, ChannelIngressResolver, CreateChannelIngressResolverParams, ResolveChannelMessageIngressParams, ResolveStableChannelMessageIngressParams, ResolvedChannelMessageIngress } from "./runtime-types.js";
/**
 * Merge configured direct, group, and pairing-store allowlists into the
 * effective lists consumed by sender and context-visibility checks.
 */
export declare function resolveChannelIngressEffectiveAllowFromLists(params: {
    allowFrom?: Array<string | number> | null;
    groupAllowFrom?: Array<string | number> | null;
    storeAllowFrom?: Array<string | number> | null;
    dmPolicy?: string | null;
    groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
};
/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
export declare function readChannelIngressStoreAllowFromForDmPolicy(params: {
    provider: PairingChannel;
    accountId: string;
    dmPolicy?: string | null;
    shouldRead?: boolean | null;
    readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]>;
/**
 * Create a reusable ingress resolver for one channel account and identity
 * descriptor.
 */
export declare function createChannelIngressResolver(base: CreateChannelIngressResolverParams): ChannelIngressResolver;
/**
 * Resolve one inbound event using a simple stable subject identity descriptor.
 */
export declare function resolveStableChannelMessageIngress(params: ResolveStableChannelMessageIngressParams): Promise<ResolvedChannelMessageIngress>;
/**
 * Collect optional route descriptors while dropping false, null, and undefined
 * entries.
 */
export declare function channelIngressRoutes(...routes: Array<ChannelIngressRouteDescriptor | false | null | undefined>): ChannelIngressRouteDescriptor[];
/**
 * Resolve sender, route, command, event, and activation gates for one inbound
 * channel event.
 */
export declare function resolveChannelMessageIngress(params: ResolveChannelMessageIngressParams): Promise<ResolvedChannelMessageIngress>;
