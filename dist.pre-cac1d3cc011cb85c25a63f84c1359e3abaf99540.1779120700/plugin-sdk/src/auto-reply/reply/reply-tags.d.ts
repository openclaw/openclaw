export declare function extractReplyToTag(text?: string, currentMessageId?: string): {
    cleaned: string;
    replyToId?: string;
    replyToCurrent: boolean;
    hasTag: boolean;
};
