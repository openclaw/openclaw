import type { ChannelId } from "../channels/plugins/types.js";
export type ChannelDirection = "inbound" | "outbound";
type ActivityEntry = {
    inboundAt: number | null;
    outboundAt: number | null;
};
export declare function recordChannelActivity(params: {
    channel: ChannelId;
    accountId?: string | null;
    direction: ChannelDirection;
    at?: number;
}): void;
export declare function getChannelActivity(params: {
    channel: ChannelId;
    accountId?: string | null;
}): ActivityEntry;
export declare function resetChannelActivityForTest(): void;
export {};
