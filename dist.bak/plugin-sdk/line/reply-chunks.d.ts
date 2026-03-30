import type { messagingApi } from "@line/bot-sdk";
export type LineReplyMessage = messagingApi.TextMessage;
export type SendLineReplyChunksParams = {
    to: string;
    chunks: string[];
    quickReplies?: string[];
    replyToken?: string | null;
    replyTokenUsed?: boolean;
    accountId?: string;
    replyMessageLine: (replyToken: string, messages: messagingApi.Message[], opts?: {
        accountId?: string;
    }) => Promise<unknown>;
    pushMessageLine: (to: string, text: string, opts?: {
        accountId?: string;
    }) => Promise<unknown>;
    pushTextMessageWithQuickReplies: (to: string, text: string, quickReplies: string[], opts?: {
        accountId?: string;
    }) => Promise<unknown>;
    createTextMessageWithQuickReplies: (text: string, quickReplies: string[]) => LineReplyMessage;
    onReplyError?: (err: unknown) => void;
};
export declare function sendLineReplyChunks(params: SendLineReplyChunksParams): Promise<{
    replyTokenUsed: boolean;
}>;
