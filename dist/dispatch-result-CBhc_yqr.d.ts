import { t as ReplyDispatchKind } from "./reply-dispatcher.types-ZeVAzUxF.js";

//#region src/channels/turn/dispatch-result.d.ts
type ChannelTurnDispatchResultLike = {
  queuedFinal?: boolean;
  counts?: Partial<Record<ReplyDispatchKind, number>>;
} | null | undefined;
type ChannelTurnVisibleDeliverySignals = {
  observedReplyDelivery?: boolean;
  fallbackDelivered?: boolean;
  deliverySummaryDelivered?: boolean;
};
declare const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS: Record<ReplyDispatchKind, number>;
declare function resolveChannelTurnDispatchCounts(result: ChannelTurnDispatchResultLike): Record<ReplyDispatchKind, number>;
declare function hasVisibleChannelTurnDispatch(result: ChannelTurnDispatchResultLike, signals?: ChannelTurnVisibleDeliverySignals): boolean;
declare function hasFinalChannelTurnDispatch(result: ChannelTurnDispatchResultLike, signals?: Pick<ChannelTurnVisibleDeliverySignals, "fallbackDelivered" | "deliverySummaryDelivered">): boolean;
//#endregion
export { hasVisibleChannelTurnDispatch as a, hasFinalChannelTurnDispatch as i, ChannelTurnVisibleDeliverySignals as n, resolveChannelTurnDispatchCounts as o, EMPTY_CHANNEL_TURN_DISPATCH_COUNTS as r, ChannelTurnDispatchResultLike as t };