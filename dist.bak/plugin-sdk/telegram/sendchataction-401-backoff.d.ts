export type TelegramSendChatActionLogger = (message: string) => void;
type ChatAction = "typing" | "upload_photo" | "record_video" | "upload_video" | "record_voice" | "upload_voice" | "upload_document" | "find_location" | "record_video_note" | "upload_video_note" | "choose_sticker";
type SendChatActionFn = (chatId: number | string, action: ChatAction, threadParams?: unknown) => Promise<unknown>;
export type TelegramSendChatActionHandler = {
    /**
     * Send a chat action with automatic 401 backoff and circuit breaker.
     * Safe to call from multiple concurrent message contexts.
     */
    sendChatAction: (chatId: number | string, action: ChatAction, threadParams?: unknown) => Promise<void>;
    isSuspended: () => boolean;
    reset: () => void;
};
export type CreateTelegramSendChatActionHandlerParams = {
    sendChatActionFn: SendChatActionFn;
    logger: TelegramSendChatActionLogger;
    maxConsecutive401?: number;
};
/**
 * Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
 * across all message contexts. This prevents the infinite loop that caused Telegram
 * to delete bots (issue #27092).
 *
 * When a 401 occurs, exponential backoff is applied (1s → 2s → 4s → ... → 5min).
 * After maxConsecutive401 failures (default 10), all sendChatAction calls are
 * suspended until reset() is called.
 */
export declare function createTelegramSendChatActionHandler({ sendChatActionFn, logger, maxConsecutive401, }: CreateTelegramSendChatActionHandlerParams): TelegramSendChatActionHandler;
export {};
