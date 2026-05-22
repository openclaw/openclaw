import type { ChannelRouteParsedTarget, ParsedChannelExplicitTarget } from "./target-parsing-loaded.js";
export { comparableChannelTargetsMatch, comparableChannelTargetsShareRoute, parseExplicitTargetForLoadedChannel, resolveComparableTargetForLoadedChannel, resolveRouteTargetForLoadedChannel, } from "./target-parsing-loaded.js";
export type { ComparableChannelTarget, ChannelRouteParsedTarget, ParsedChannelExplicitTarget, } from "./target-parsing-loaded.js";
export declare function parseExplicitTargetForChannel(channel: string, rawTarget: string): ParsedChannelExplicitTarget | null;
export declare function resolveRouteTargetForChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null;
/** @deprecated Use `resolveRouteTargetForChannel`. */
export declare function resolveComparableTargetForChannel(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null;
