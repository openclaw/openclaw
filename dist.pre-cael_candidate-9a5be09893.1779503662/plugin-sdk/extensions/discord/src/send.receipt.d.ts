import { type MessageReceipt, type MessageReceiptPartKind } from "openclaw/plugin-sdk/channel-message";
import type { DiscordSendResult } from "./send.types.js";
export type DiscordReceiptResultSource = {
    id?: string | null;
    channel_id?: string | null;
    platformMessageIds?: readonly string[];
};
export declare function createDiscordSendReceipt(params: {
    platformMessageIds: readonly string[];
    channelId?: string;
    kind: MessageReceiptPartKind;
    threadId?: string;
    replyToId?: string;
}): MessageReceipt;
export declare function createDiscordSendResult(params: {
    result: DiscordReceiptResultSource;
    fallbackChannelId: string;
    kind: MessageReceiptPartKind;
    threadId?: string | number;
    replyToId?: string;
}): DiscordSendResult;
