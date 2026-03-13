type SelfChatCacheKeyParts = {
    accountId: string;
    sender: string;
    isGroup: boolean;
    chatId?: number;
};
export type SelfChatLookup = SelfChatCacheKeyParts & {
    text?: string;
    createdAt?: number;
};
export type SelfChatCache = {
    remember: (lookup: SelfChatLookup) => void;
    has: (lookup: SelfChatLookup) => boolean;
};
export declare function createSelfChatCache(): SelfChatCache;
export {};
