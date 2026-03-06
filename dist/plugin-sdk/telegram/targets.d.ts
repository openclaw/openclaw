export type TelegramTarget = {
    chatId: string;
    messageThreadId?: number;
    chatType: "direct" | "group" | "unknown";
};
export declare function stripTelegramInternalPrefixes(to: string): string;
export declare function normalizeTelegramChatId(raw: string): string | undefined;
export declare function isNumericTelegramChatId(raw: string): boolean;
export declare function normalizeTelegramLookupTarget(raw: string): string | undefined;
export declare function parseTelegramTarget(to: string): TelegramTarget;
export declare function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown";
