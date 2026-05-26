import { type OutboundMediaAccess } from "../media/load-options.js";
export type OutboundMediaLoadOptions = {
    maxBytes?: number;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    proxyUrl?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    requestInit?: RequestInit;
    trustExplicitProxyDns?: boolean;
};
/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export declare function loadOutboundMediaFromUrl(mediaUrl: string, options?: OutboundMediaLoadOptions): Promise<import("./web-media.js").WebMediaResult>;
