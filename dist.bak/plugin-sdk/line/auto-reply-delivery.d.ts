import type { messagingApi } from "@line/bot-sdk";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { FlexContainer } from "./flex-templates.js";
import type { ProcessedLineMessage } from "./markdown-to-line.js";
import type { SendLineReplyChunksParams } from "./reply-chunks.js";
import type { LineChannelData, LineTemplateMessagePayload } from "./types.js";
export type LineAutoReplyDeps = {
    buildTemplateMessageFromPayload: (payload: LineTemplateMessagePayload) => messagingApi.TemplateMessage | null;
    processLineMessage: (text: string) => ProcessedLineMessage;
    chunkMarkdownText: (text: string, limit: number) => string[];
    sendLineReplyChunks: (params: SendLineReplyChunksParams) => Promise<{
        replyTokenUsed: boolean;
    }>;
    createQuickReplyItems: (labels: string[]) => messagingApi.QuickReply;
    pushMessagesLine: (to: string, messages: messagingApi.Message[], opts?: {
        accountId?: string;
    }) => Promise<unknown>;
    createFlexMessage: (altText: string, contents: FlexContainer) => messagingApi.FlexMessage;
    createImageMessage: (originalContentUrl: string, previewImageUrl?: string) => messagingApi.ImageMessage;
    createLocationMessage: (location: {
        title: string;
        address: string;
        latitude: number;
        longitude: number;
    }) => messagingApi.LocationMessage;
} & Pick<SendLineReplyChunksParams, "replyMessageLine" | "pushMessageLine" | "pushTextMessageWithQuickReplies" | "createTextMessageWithQuickReplies" | "onReplyError">;
export declare function deliverLineAutoReply(params: {
    payload: ReplyPayload;
    lineData: LineChannelData;
    to: string;
    replyToken?: string | null;
    replyTokenUsed: boolean;
    accountId?: string;
    textLimit: number;
    deps: LineAutoReplyDeps;
}): Promise<{
    replyTokenUsed: boolean;
}>;
