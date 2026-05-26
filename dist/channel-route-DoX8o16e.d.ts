//#region src/plugin-sdk/channel-route.d.ts
type ChannelRouteChatType = "direct" | "group" | "channel";
type ChannelRouteThreadKind = "topic" | "thread" | "reply";
type ChannelRouteThreadSource = "explicit" | "target" | "session" | "turn";
type ChannelRouteRef = {
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
type ChannelRouteRefInput = {
  channel?: unknown;
  accountId?: unknown;
  to?: unknown;
  rawTo?: unknown;
  chatType?: ChannelRouteChatType;
  threadId?: unknown;
  threadKind?: ChannelRouteThreadKind;
  threadSource?: ChannelRouteThreadSource;
};
type ChannelRouteTargetInput = Pick<ChannelRouteRefInput, "channel" | "accountId" | "to" | "rawTo" | "chatType" | "threadId">;
type ChannelRouteKeyInput = ChannelRouteRef | ChannelRouteTargetInput;
type ChannelRouteExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChannelRouteChatType;
};
type ChannelRouteExplicitTargetParser = (channel: string, rawTarget: string) => ChannelRouteExplicitTarget | null;
declare function normalizeRouteThreadId(value: unknown): string | number | undefined;
declare function stringifyRouteThreadId(value: unknown): string | undefined;
declare function normalizeChannelRouteRef(input?: ChannelRouteRefInput): ChannelRouteRef | undefined;
declare function channelRouteTarget(route?: ChannelRouteRef): string | undefined;
declare function channelRouteThreadId(route?: ChannelRouteRef): string | number | undefined;
declare function normalizeChannelRouteTarget(input?: ChannelRouteTargetInput | null): ChannelRouteRef | undefined;
type ChannelRouteParsedTarget = ChannelRouteTargetInput & {
  channel: string;
  rawTo: string;
  to: string;
  threadId?: string | number;
  chatType?: ChannelRouteChatType;
};
declare function resolveChannelRouteTargetWithParser(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
  parseExplicitTarget: ChannelRouteExplicitTargetParser;
}): ChannelRouteParsedTarget | null;
declare function channelRouteDedupeKey(input?: ChannelRouteTargetInput | null): string;
/** @deprecated Use `channelRouteDedupeKey`. */
declare function channelRouteIdentityKey(input?: ChannelRouteTargetInput | null): string;
declare function channelRoutesMatchExact(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean;
declare function channelRoutesShareConversation(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean;
declare function channelRouteTargetsMatchExact(params: {
  left?: ChannelRouteTargetInput | null;
  right?: ChannelRouteTargetInput | null;
}): boolean;
declare function channelRouteTargetsShareConversation(params: {
  left?: ChannelRouteTargetInput | null;
  right?: ChannelRouteTargetInput | null;
}): boolean;
declare function channelRouteCompactKey(route?: ChannelRouteKeyInput | null): string | undefined;
/** @deprecated Use `channelRouteCompactKey`. */
declare function channelRouteKey(route?: ChannelRouteRef): string | undefined;
//#endregion
export { normalizeRouteThreadId as C, normalizeChannelRouteTarget as S, stringifyRouteThreadId as T, channelRouteTargetsShareConversation as _, ChannelRouteParsedTarget as a, channelRoutesShareConversation as b, ChannelRouteTargetInput as c, channelRouteCompactKey as d, channelRouteDedupeKey as f, channelRouteTargetsMatchExact as g, channelRouteTarget as h, ChannelRouteKeyInput as i, ChannelRouteThreadKind as l, channelRouteKey as m, ChannelRouteExplicitTarget as n, ChannelRouteRef as o, channelRouteIdentityKey as p, ChannelRouteExplicitTargetParser as r, ChannelRouteRefInput as s, ChannelRouteChatType as t, ChannelRouteThreadSource as u, channelRouteThreadId as v, resolveChannelRouteTargetWithParser as w, normalizeChannelRouteRef as x, channelRoutesMatchExact as y };