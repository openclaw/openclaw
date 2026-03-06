export type OutboundReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
};
export declare function normalizeOutboundReplyPayload(payload: Record<string, unknown>): OutboundReplyPayload;
export declare function createNormalizedOutboundDeliverer(handler: (payload: OutboundReplyPayload) => Promise<void>): (payload: unknown) => Promise<void>;
export declare function resolveOutboundMediaUrls(payload: {
    mediaUrls?: string[];
    mediaUrl?: string;
}): string[];
export declare function formatTextWithAttachmentLinks(text: string | undefined, mediaUrls: string[]): string;
export declare function sendMediaWithLeadingCaption(params: {
    mediaUrls: string[];
    caption: string;
    send: (payload: {
        mediaUrl: string;
        caption?: string;
    }) => Promise<void>;
    onError?: (error: unknown, mediaUrl: string) => void;
}): Promise<boolean>;
