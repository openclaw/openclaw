export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";
export declare function isRecoverableTelegramNetworkError(err: unknown, options?: {
    context?: TelegramNetworkErrorContext;
    allowMessageMatch?: boolean;
}): boolean;
