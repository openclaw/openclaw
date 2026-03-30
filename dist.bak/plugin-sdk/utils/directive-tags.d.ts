export type InlineDirectiveParseResult = {
    text: string;
    audioAsVoice: boolean;
    replyToId?: string;
    replyToExplicitId?: string;
    replyToCurrent: boolean;
    hasAudioTag: boolean;
    hasReplyTag: boolean;
};
type InlineDirectiveParseOptions = {
    currentMessageId?: string;
    stripAudioTag?: boolean;
    stripReplyTags?: boolean;
};
type StripInlineDirectiveTagsResult = {
    text: string;
    changed: boolean;
};
export type DisplayMessageWithContent = {
    content?: unknown;
} & Record<string, unknown>;
export declare function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult;
/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
export declare function stripInlineDirectiveTagsFromMessageForDisplay(message: DisplayMessageWithContent | undefined): DisplayMessageWithContent | undefined;
export declare function parseInlineDirectives(text?: string, options?: InlineDirectiveParseOptions): InlineDirectiveParseResult;
export {};
