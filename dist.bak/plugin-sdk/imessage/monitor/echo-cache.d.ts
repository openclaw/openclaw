export type SentMessageLookup = {
    text?: string;
    messageId?: string;
};
export type SentMessageCache = {
    remember: (scope: string, lookup: SentMessageLookup) => void;
    has: (scope: string, lookup: SentMessageLookup) => boolean;
};
export declare function createSentMessageCache(): SentMessageCache;
