export type ReplyDirectiveParseResult = {
    text: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
    replyToCurrent: boolean;
    replyToTag: boolean;
    audioAsVoice?: boolean;
    isSilent: boolean;
};
export declare function parseReplyDirectives(raw: string, options?: {
    currentMessageId?: string;
    silentToken?: string;
}): ReplyDirectiveParseResult;
