import type { GatewayRequestHandlers } from "./types.js";
export { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS, resolveEffectiveChatHistoryMaxChars, sanitizeChatHistoryMessages, } from "../chat-display-projection.js";
export declare const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: number;
export declare function sanitizeChatSendMessageInput(message: string): {
    ok: true;
    message: string;
} | {
    ok: false;
    error: string;
};
export declare function augmentChatHistoryWithCanvasBlocks(messages: unknown[]): unknown[];
export declare function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown>;
export declare function replaceOversizedChatHistoryMessages(params: {
    messages: unknown[];
    maxSingleMessageBytes: number;
}): {
    messages: unknown[];
    replacedCount: number;
};
export declare function enforceChatHistoryFinalBudget(params: {
    messages: unknown[];
    maxBytes: number;
}): {
    messages: unknown[];
    placeholderCount: number;
};
export declare const chatHandlers: GatewayRequestHandlers;
