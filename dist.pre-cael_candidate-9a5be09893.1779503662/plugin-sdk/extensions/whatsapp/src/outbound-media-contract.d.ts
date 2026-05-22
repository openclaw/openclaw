type WhatsAppOutboundPayloadLike = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: readonly string[];
};
type WhatsAppLoadedMediaLike = {
    buffer: Buffer;
    contentType?: string;
    kind?: string;
    fileName?: string;
};
type NormalizedWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<T, "text" | "mediaUrl" | "mediaUrls"> & {
    text: string;
    mediaUrl?: string;
    mediaUrls?: string[];
};
export type DeliverableWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<NormalizedWhatsAppOutboundPayload<T>, "text"> & {
    text?: string;
};
type CanonicalWhatsAppLoadedMedia = {
    buffer: Buffer;
    kind: "image" | "audio" | "video" | "document";
    mimetype: string;
    fileName?: string;
};
export declare function normalizeWhatsAppPayloadText(text: string | undefined): string;
export declare function normalizeWhatsAppPayloadTextPreservingIndentation(text: string | undefined): string;
export declare function resolveWhatsAppOutboundMediaUrls(payload: Pick<WhatsAppOutboundPayloadLike, "mediaUrl" | "mediaUrls">): string[];
export declare function normalizeWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike>(payload: T, options?: {
    normalizeText?: (text: string | undefined) => string;
}): NormalizedWhatsAppOutboundPayload<T>;
export declare function prepareWhatsAppOutboundMedia(media: WhatsAppLoadedMediaLike, mediaUrl?: string): Promise<CanonicalWhatsAppLoadedMedia>;
export declare function sendWhatsAppOutboundWithRetry<T>(params: {
    send: () => Promise<T>;
    onRetry?: (params: {
        attempt: number;
        maxAttempts: number;
        backoffMs: number;
        error: unknown;
        errorText: string;
    }) => Promise<void> | void;
    maxAttempts?: number;
}): Promise<T>;
export {};
