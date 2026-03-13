import type { IncomingMessage, ServerResponse } from "node:http";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
export type WebhookBodyReadProfile = "pre-auth" | "post-auth";
export declare const WEBHOOK_BODY_READ_DEFAULTS: Readonly<{
    preAuth: {
        maxBytes: number;
        timeoutMs: number;
    };
    postAuth: {
        maxBytes: number;
        timeoutMs: number;
    };
}>;
export declare const WEBHOOK_IN_FLIGHT_DEFAULTS: Readonly<{
    maxInFlightPerKey: 8;
    maxTrackedKeys: 4096;
}>;
export type WebhookInFlightLimiter = {
    tryAcquire: (key: string) => boolean;
    release: (key: string) => void;
    size: () => number;
    clear: () => void;
};
export declare function createWebhookInFlightLimiter(options?: {
    maxInFlightPerKey?: number;
    maxTrackedKeys?: number;
}): WebhookInFlightLimiter;
export declare function isJsonContentType(value: string | string[] | undefined): boolean;
export declare function applyBasicWebhookRequestGuards(params: {
    req: IncomingMessage;
    res: ServerResponse;
    allowMethods?: readonly string[];
    rateLimiter?: FixedWindowRateLimiter;
    rateLimitKey?: string;
    nowMs?: number;
    requireJsonContentType?: boolean;
}): boolean;
export declare function beginWebhookRequestPipelineOrReject(params: {
    req: IncomingMessage;
    res: ServerResponse;
    allowMethods?: readonly string[];
    rateLimiter?: FixedWindowRateLimiter;
    rateLimitKey?: string;
    nowMs?: number;
    requireJsonContentType?: boolean;
    inFlightLimiter?: WebhookInFlightLimiter;
    inFlightKey?: string;
    inFlightLimitStatusCode?: number;
    inFlightLimitMessage?: string;
}): {
    ok: true;
    release: () => void;
} | {
    ok: false;
};
export declare function readWebhookBodyOrReject(params: {
    req: IncomingMessage;
    res: ServerResponse;
    maxBytes?: number;
    timeoutMs?: number;
    profile?: WebhookBodyReadProfile;
    invalidBodyMessage?: string;
}): Promise<{
    ok: true;
    value: string;
} | {
    ok: false;
}>;
export declare function readJsonWebhookBodyOrReject(params: {
    req: IncomingMessage;
    res: ServerResponse;
    maxBytes?: number;
    timeoutMs?: number;
    profile?: WebhookBodyReadProfile;
    emptyObjectOnEmpty?: boolean;
    invalidJsonMessage?: string;
}): Promise<{
    ok: true;
    value: unknown;
} | {
    ok: false;
}>;
