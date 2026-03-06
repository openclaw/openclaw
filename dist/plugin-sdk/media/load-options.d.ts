export type OutboundMediaLoadParams = {
    maxBytes?: number;
    mediaLocalRoots?: readonly string[];
};
export type OutboundMediaLoadOptions = {
    maxBytes?: number;
    localRoots?: readonly string[];
};
export declare function resolveOutboundMediaLocalRoots(mediaLocalRoots?: readonly string[]): readonly string[] | undefined;
export declare function buildOutboundMediaLoadOptions(params?: OutboundMediaLoadParams): OutboundMediaLoadOptions;
