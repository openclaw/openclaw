export type ChannelRouteChatType = "direct" | "group" | "channel";
export type ChannelRouteThreadKind = "topic" | "thread" | "reply";
export type ChannelRouteThreadSource = "explicit" | "target" | "session" | "turn";
export type ChannelRouteRef = {
    channel?: string;
    accountId?: string;
    target?: {
        to: string;
        rawTo?: string;
        chatType?: ChannelRouteChatType;
    };
    thread?: {
        id: string | number;
        kind?: ChannelRouteThreadKind;
        source?: ChannelRouteThreadSource;
    };
};
export type ChannelRouteRefInput = {
    channel?: unknown;
    accountId?: unknown;
    to?: unknown;
    rawTo?: unknown;
    chatType?: ChannelRouteChatType;
    threadId?: unknown;
    threadKind?: ChannelRouteThreadKind;
    threadSource?: ChannelRouteThreadSource;
};
export type ChannelRouteTargetInput = Pick<ChannelRouteRefInput, "channel" | "accountId" | "to" | "rawTo" | "chatType" | "threadId">;
export type ChannelRouteKeyInput = ChannelRouteRef | ChannelRouteTargetInput;
export type ChannelRouteExplicitTarget = {
    to: string;
    threadId?: string | number;
    chatType?: ChannelRouteChatType;
};
export type ChannelRouteExplicitTargetParser = (channel: string, rawTarget: string) => ChannelRouteExplicitTarget | null;
export declare function normalizeRouteThreadId(value: unknown): string | number | undefined;
export declare function stringifyRouteThreadId(value: unknown): string | undefined;
export declare function normalizeChannelRouteRef(input?: ChannelRouteRefInput): ChannelRouteRef | undefined;
export declare function channelRouteTarget(route?: ChannelRouteRef): string | undefined;
export declare function channelRouteThreadId(route?: ChannelRouteRef): string | number | undefined;
export declare function normalizeChannelRouteTarget(input?: ChannelRouteTargetInput | null): ChannelRouteRef | undefined;
export type ChannelRouteParsedTarget = ChannelRouteTargetInput & {
    channel: string;
    rawTo: string;
    to: string;
    threadId?: string | number;
    chatType?: ChannelRouteChatType;
};
export declare function resolveChannelRouteTargetWithParser(params: {
    channel: string;
    rawTarget?: string | null;
    fallbackThreadId?: string | number | null;
    parseExplicitTarget: ChannelRouteExplicitTargetParser;
}): ChannelRouteParsedTarget | null;
export declare function channelRouteDedupeKey(input?: ChannelRouteTargetInput | null): string;
/** @deprecated Use `channelRouteDedupeKey`. */
export declare function channelRouteIdentityKey(input?: ChannelRouteTargetInput | null): string;
export declare function channelRoutesMatchExact(params: {
    left?: ChannelRouteRef | null;
    right?: ChannelRouteRef | null;
}): boolean;
export declare function channelRoutesShareConversation(params: {
    left?: ChannelRouteRef | null;
    right?: ChannelRouteRef | null;
}): boolean;
export declare function channelRouteTargetsMatchExact(params: {
    left?: ChannelRouteTargetInput | null;
    right?: ChannelRouteTargetInput | null;
}): boolean;
export declare function channelRouteTargetsShareConversation(params: {
    left?: ChannelRouteTargetInput | null;
    right?: ChannelRouteTargetInput | null;
}): boolean;
export declare function channelRouteCompactKey(route?: ChannelRouteKeyInput | null): string | undefined;
/** @deprecated Use `channelRouteCompactKey`. */
export declare function channelRouteKey(route?: ChannelRouteRef): string | undefined;
