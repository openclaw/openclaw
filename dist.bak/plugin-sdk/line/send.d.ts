import { messagingApi } from "@line/bot-sdk";
import type { LineSendResult } from "./types.js";
type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type ImageMessage = messagingApi.ImageMessage;
type LocationMessage = messagingApi.LocationMessage;
type FlexContainer = messagingApi.FlexContainer;
type TemplateMessage = messagingApi.TemplateMessage;
type QuickReply = messagingApi.QuickReply;
interface LineSendOpts {
    channelAccessToken?: string;
    accountId?: string;
    verbose?: boolean;
    mediaUrl?: string;
    replyToken?: string;
}
type LinePushOpts = Pick<LineSendOpts, "channelAccessToken" | "accountId" | "verbose">;
export declare function createImageMessage(originalContentUrl: string, previewImageUrl?: string): ImageMessage;
export declare function createLocationMessage(location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
}): LocationMessage;
export declare function sendMessageLine(to: string, text: string, opts?: LineSendOpts): Promise<LineSendResult>;
export declare function pushMessageLine(to: string, text: string, opts?: LineSendOpts): Promise<LineSendResult>;
export declare function replyMessageLine(replyToken: string, messages: Message[], opts?: LinePushOpts): Promise<void>;
export declare function pushMessagesLine(to: string, messages: Message[], opts?: LinePushOpts): Promise<LineSendResult>;
export declare function createFlexMessage(altText: string, contents: messagingApi.FlexContainer): messagingApi.FlexMessage;
/**
 * Push an image message to a user/group
 */
export declare function pushImageMessage(to: string, originalContentUrl: string, previewImageUrl?: string, opts?: LinePushOpts): Promise<LineSendResult>;
/**
 * Push a location message to a user/group
 */
export declare function pushLocationMessage(to: string, location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
}, opts?: LinePushOpts): Promise<LineSendResult>;
/**
 * Push a Flex Message to a user/group
 */
export declare function pushFlexMessage(to: string, altText: string, contents: FlexContainer, opts?: LinePushOpts): Promise<LineSendResult>;
/**
 * Push a Template Message to a user/group
 */
export declare function pushTemplateMessage(to: string, template: TemplateMessage, opts?: LinePushOpts): Promise<LineSendResult>;
/**
 * Push a text message with quick reply buttons
 */
export declare function pushTextMessageWithQuickReplies(to: string, text: string, quickReplyLabels: string[], opts?: LinePushOpts): Promise<LineSendResult>;
/**
 * Create quick reply buttons to attach to a message
 */
export declare function createQuickReplyItems(labels: string[]): QuickReply;
/**
 * Create a text message with quick reply buttons
 */
export declare function createTextMessageWithQuickReplies(text: string, quickReplyLabels: string[]): TextMessage & {
    quickReply: QuickReply;
};
/**
 * Show loading animation to user (lasts up to 20 seconds or until next message)
 */
export declare function showLoadingAnimation(chatId: string, opts?: {
    channelAccessToken?: string;
    accountId?: string;
    loadingSeconds?: number;
}): Promise<void>;
/**
 * Fetch user profile (display name, picture URL)
 */
export declare function getUserProfile(userId: string, opts?: {
    channelAccessToken?: string;
    accountId?: string;
    useCache?: boolean;
}): Promise<{
    displayName: string;
    pictureUrl?: string;
} | null>;
/**
 * Get user's display name (with fallback to userId)
 */
export declare function getUserDisplayName(userId: string, opts?: {
    channelAccessToken?: string;
    accountId?: string;
}): Promise<string>;
export {};
