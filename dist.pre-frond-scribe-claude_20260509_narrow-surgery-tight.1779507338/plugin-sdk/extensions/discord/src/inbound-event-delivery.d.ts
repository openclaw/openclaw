import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export type DiscordInboundEventDeliveryEnd = () => void;
type ActiveEvent = {
    outboundTo: string;
    outboundAccountId?: string;
    markInboundEventDelivered: () => void;
};
export declare function beginDiscordInboundEventDeliveryCorrelation(sessionKey: string | undefined, event: ActiveEvent, options?: {
    inboundEventKind?: string;
}): DiscordInboundEventDeliveryEnd;
export declare function notifyDiscordInboundEventOutboundSuccess(params: {
    sessionKey: string | undefined;
    to: string;
    accountId?: string | null;
    inboundEventKind?: string;
}): void;
export declare function withDiscordInboundEventDeliveryMetadata(payload: ReplyPayload, params: {
    sessionKey?: string | null;
    inboundEventKind?: string;
}): ReplyPayload;
export declare function notifyDiscordInboundEventOutboundPayloadSuccess(params: {
    payload: ReplyPayload;
    to: string;
    accountId?: string | null;
}): void;
export {};
