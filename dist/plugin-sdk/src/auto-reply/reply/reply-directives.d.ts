export type ReplyDirectiveParseResult = {
    text: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
    replyToCurrent?: boolean;
    replyToTag: boolean;
    audioAsVoice?: boolean;
    isSilent: boolean;
};
export type ReplyDirectiveParseOptions = {
    currentMessageId?: string;
    silentToken?: string;
    extractMarkdownImages?: boolean;
};
export declare function parseReplyDirectives(raw: string, options?: ReplyDirectiveParseOptions): ReplyDirectiveParseResult;
