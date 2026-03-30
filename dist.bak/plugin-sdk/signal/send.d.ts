import { type SignalTextStyleRange } from "./format.js";
export type SignalSendOpts = {
    baseUrl?: string;
    account?: string;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    maxBytes?: number;
    timeoutMs?: number;
    textMode?: "markdown" | "plain";
    textStyles?: SignalTextStyleRange[];
};
export type SignalSendResult = {
    messageId: string;
    timestamp?: number;
};
export type SignalRpcOpts = Pick<SignalSendOpts, "baseUrl" | "account" | "accountId" | "timeoutMs">;
export type SignalReceiptType = "read" | "viewed";
export declare function sendMessageSignal(to: string, text: string, opts?: SignalSendOpts): Promise<SignalSendResult>;
export declare function sendTypingSignal(to: string, opts?: SignalRpcOpts & {
    stop?: boolean;
}): Promise<boolean>;
export declare function sendReadReceiptSignal(to: string, targetTimestamp: number, opts?: SignalRpcOpts & {
    type?: SignalReceiptType;
}): Promise<boolean>;
