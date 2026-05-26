export declare const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8000;
export declare function resolveEffectiveChatHistoryMaxChars(cfg: {
    gateway?: {
        webchat?: {
            chatHistoryMaxChars?: number;
        };
    };
}, maxChars?: number): number;
export declare function isToolHistoryBlockType(type: unknown): boolean;
export declare function sanitizeChatHistoryMessages(messages: unknown[], maxChars?: number): unknown[];
export declare function projectChatDisplayMessages(messages: unknown[], options?: {
    maxChars?: number;
    stripEnvelope?: boolean;
}): Array<Record<string, unknown>>;
export declare function projectRecentChatDisplayMessages(messages: unknown[], options?: {
    maxChars?: number;
    maxMessages?: number;
    stripEnvelope?: boolean;
}): Array<Record<string, unknown>>;
export declare function projectChatDisplayMessage(message: unknown, options?: {
    maxChars?: number;
    stripEnvelope?: boolean;
}): Record<string, unknown> | undefined;
