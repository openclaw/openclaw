import type { MessageReceipt, MessageReceiptPartKind, MessageReceiptSourceResult } from "./types.js";
type MessageReceiptInputResult = MessageReceiptSourceResult & {
    receipt?: MessageReceipt;
};
export declare function createMessageReceiptFromOutboundResults(params: {
    results: readonly MessageReceiptInputResult[];
    kind?: MessageReceiptPartKind;
    threadId?: string;
    replyToId?: string;
    sentAt?: number;
}): MessageReceipt;
export declare function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[];
export declare function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined;
export {};
