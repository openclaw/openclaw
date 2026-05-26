import { type ChannelRouteExplicitTarget, type ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";
export type { ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";
export type ParsedChannelExplicitTarget = ChannelRouteExplicitTarget;
/** @deprecated Use `ChannelRouteParsedTarget`. */
export type ComparableChannelTarget = ChannelRouteParsedTarget;
export declare function parseExplicitTargetForLoadedChannel(channel: string, rawTarget: string): ParsedChannelExplicitTarget | null;
export declare function resolveRouteTargetForLoadedChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null;
/** @deprecated Use `resolveRouteTargetForLoadedChannel`. */
export declare function resolveComparableTargetForLoadedChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null;
/** @deprecated Use `channelRouteTargetsMatchExact` from `openclaw/plugin-sdk/channel-route`. */
export declare function comparableChannelTargetsMatch(params: {
    left?: ChannelRouteParsedTarget | null;
    right?: ChannelRouteParsedTarget | null;
}): boolean;
/** @deprecated Use `channelRouteTargetsShareConversation` from `openclaw/plugin-sdk/channel-route`. */
export declare function comparableChannelTargetsShareRoute(params: {
    left?: ChannelRouteParsedTarget | null;
    right?: ChannelRouteParsedTarget | null;
}): boolean;
