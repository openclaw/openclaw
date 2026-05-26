export type InboundMediaContext = {
    StickerMediaIncluded?: unknown;
    Sticker?: unknown;
    MediaPath?: unknown;
    MediaUrl?: unknown;
    MediaPaths?: readonly unknown[];
    MediaUrls?: readonly unknown[];
    MediaTypes?: readonly unknown[];
};
export declare function hasInboundMedia(ctx: InboundMediaContext): boolean;
