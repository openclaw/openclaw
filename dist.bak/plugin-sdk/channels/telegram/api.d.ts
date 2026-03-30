export declare function fetchTelegramChatId(params: {
    token: string;
    chatId: string;
    signal?: AbortSignal;
}): Promise<string | null>;
