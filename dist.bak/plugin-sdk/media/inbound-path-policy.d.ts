import type { OpenClawConfig } from "../config/config.js";
export declare const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: readonly ["/Users/*/Library/Messages/Attachments"];
export declare function isValidInboundPathRootPattern(value: string): boolean;
export declare function normalizeInboundPathRoots(roots?: readonly string[]): string[];
export declare function mergeInboundPathRoots(...rootsLists: Array<readonly string[] | undefined>): string[];
export declare function isInboundPathAllowed(params: {
    filePath: string;
    roots: readonly string[];
    fallbackRoots?: readonly string[];
}): boolean;
export declare function resolveIMessageAttachmentRoots(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[];
export declare function resolveIMessageRemoteAttachmentRoots(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[];
