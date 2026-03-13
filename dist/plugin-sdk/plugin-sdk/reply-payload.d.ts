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
export declare function sendPayloadWithChunkedTextAndMedia<TContext extends {
    payload: object;
}, TResult>(params: {
    ctx: TContext;
    textChunkLimit?: number;
    chunker?: ((text: string, limit: number) => string[]) | null;
    sendText: (ctx: TContext & {
        text: string;
    }) => Promise<TResult>;
    sendMedia: (ctx: TContext & {
        text: string;
        mediaUrl: string;
    }) => Promise<TResult>;
    emptyResult: TResult;
}): Promise<TResult>;
export declare function isNumericTargetId(raw: string): boolean;
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
