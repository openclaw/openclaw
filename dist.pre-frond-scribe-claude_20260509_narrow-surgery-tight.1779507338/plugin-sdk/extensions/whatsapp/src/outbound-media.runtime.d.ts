export declare function loadOutboundMediaFromUrl(mediaUrl: string, options?: {
    maxBytes?: number;
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    optimizeImages?: boolean;
}): Promise<import("openclaw/plugin-sdk/web-media").WebMediaResult>;
