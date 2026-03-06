export declare function formatAllowFromLowercase(params: {
    allowFrom: Array<string | number>;
    stripPrefixRe?: RegExp;
}): string[];
export declare function isNormalizedSenderAllowed(params: {
    senderId: string | number;
    allowFrom: Array<string | number>;
    stripPrefixRe?: RegExp;
}): boolean;
type ParsedChatAllowTarget = {
    kind: "chat_id";
    chatId: number;
} | {
    kind: "chat_guid";
    chatGuid: string;
} | {
    kind: "chat_identifier";
    chatIdentifier: string;
} | {
    kind: "handle";
    handle: string;
};
export declare function isAllowedParsedChatSender<TParsed extends ParsedChatAllowTarget>(params: {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
    normalizeSender: (sender: string) => string;
    parseAllowTarget: (entry: string) => TParsed;
}): boolean;
export {};
