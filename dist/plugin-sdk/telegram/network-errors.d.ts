export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";
export type TelegramNetworkErrorOrigin = {
    method?: string | null;
    url?: string | null;
};
export declare function tagTelegramNetworkError(err: unknown, origin: TelegramNetworkErrorOrigin): void;
export declare function getTelegramNetworkErrorOrigin(err: unknown): TelegramNetworkErrorOrigin | null;
export declare function isTelegramPollingNetworkError(err: unknown): boolean;
/**
 * Returns true if the error is safe to retry for a non-idempotent Telegram send operation
 * (e.g. sendMessage). Only matches errors that are guaranteed to have occurred *before*
 * the request reached Telegram's servers, preventing duplicate message delivery.
 *
 * Use this instead of isRecoverableTelegramNetworkError for sendMessage/sendPhoto/etc.
 * calls where a retry would create a duplicate visible message.
 */
export declare function isSafeToRetrySendError(err: unknown): boolean;
/** Returns true for HTTP 5xx server errors (error may have been processed). */
export declare function isTelegramServerError(err: unknown): boolean;
/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
export declare function isTelegramClientRejection(err: unknown): boolean;
export declare function isRecoverableTelegramNetworkError(err: unknown, options?: {
    context?: TelegramNetworkErrorContext;
    allowMessageMatch?: boolean;
}): boolean;
