import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
export declare const DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS: {
    readonly maxBytes: number;
    readonly maxWidth: 4096;
    readonly maxHeight: 4096;
    readonly maxPixels: 20000000;
};
export type ManagedImageAttachmentLimits = {
    maxBytes: number;
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
};
type ManagedImageAttachmentLimitsConfig = Partial<Pick<ManagedImageAttachmentLimits, "maxBytes" | "maxWidth" | "maxHeight" | "maxPixels">>;
type ManagedImageBlock = Record<string, unknown>;
type CleanupManagedOutgoingImageRecordsResult = {
    deletedRecordCount: number;
    deletedFileCount: number;
    retainedCount: number;
};
export declare function resolveManagedImageAttachmentLimits(config?: ManagedImageAttachmentLimitsConfig | null): ManagedImageAttachmentLimits;
export declare function cleanupManagedOutgoingImageRecords(params?: {
    stateDir?: string;
    nowMs?: number;
    transientMaxAgeMs?: number;
    sessionKey?: string;
    forceDeleteSessionRecords?: boolean;
}): Promise<CleanupManagedOutgoingImageRecordsResult>;
export declare function attachManagedOutgoingImagesToMessage(params: {
    messageId: string;
    blocks?: readonly Record<string, unknown>[];
    stateDir?: string;
}): Promise<void>;
export declare function createManagedOutgoingImageBlocks(params: {
    sessionKey: string;
    mediaUrls?: string[] | null;
    stateDir?: string;
    messageId?: string | null;
    limits?: ManagedImageAttachmentLimitsConfig | null;
    localRoots?: readonly string[] | "any";
    continueOnPrepareError?: boolean;
    onPrepareError?: (error: Error) => void;
}): Promise<ManagedImageBlock[]>;
export declare function handleManagedOutgoingImageHttpRequest(req: IncomingMessage, res: ServerResponse, opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    stateDir?: string;
}): Promise<boolean>;
export {};
