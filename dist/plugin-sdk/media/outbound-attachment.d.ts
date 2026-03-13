export declare function resolveOutboundAttachmentFromUrl(mediaUrl: string, maxBytes: number, options?: {
    localRoots?: readonly string[];
}): Promise<{
    path: string;
    contentType?: string;
}>;
