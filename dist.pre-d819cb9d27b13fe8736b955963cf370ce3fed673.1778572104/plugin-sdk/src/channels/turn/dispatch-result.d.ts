import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
export type ChannelTurnDispatchResultLike = {
    queuedFinal?: boolean;
    counts?: Partial<Record<ReplyDispatchKind, number>>;
} | null | undefined;
export type ChannelTurnVisibleDeliverySignals = {
    observedReplyDelivery?: boolean;
    fallbackDelivered?: boolean;
    deliverySummaryDelivered?: boolean;
};
export declare const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS: Record<ReplyDispatchKind, number>;
export declare function resolveChannelTurnDispatchCounts(result: ChannelTurnDispatchResultLike): Record<ReplyDispatchKind, number>;
export declare function hasVisibleChannelTurnDispatch(result: ChannelTurnDispatchResultLike, signals?: ChannelTurnVisibleDeliverySignals): boolean;
export declare function hasFinalChannelTurnDispatch(result: ChannelTurnDispatchResultLike, signals?: Pick<ChannelTurnVisibleDeliverySignals, "fallbackDelivered" | "deliverySummaryDelivered">): boolean;
