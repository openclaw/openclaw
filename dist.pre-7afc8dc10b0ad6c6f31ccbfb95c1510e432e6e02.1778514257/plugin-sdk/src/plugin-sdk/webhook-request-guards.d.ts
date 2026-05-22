import type { IncomingMessage, ServerResponse } from "node:http";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
export type WebhookBodyReadProfile = "pre-auth" | "post-auth";
export { installRequestBodyLimitGuard, isRequestBodyLimitError, readJsonBodyWithLimit, readRequestBodyWithLimit, requestBodyErrorToText, } from "../infra/http-body.js";
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
/** Create an in-memory limiter that caps concurrent webhook handlers per key. */
export declare function createWebhookInFlightLimiter(options?: {
    maxInFlightPerKey?: number;
    maxTrackedKeys?: number;
}): WebhookInFlightLimiter;
/** Detect JSON content types, including structured syntax suffixes like `application/ld+json`. */
export declare function isJsonContentType(value: string | string[] | undefined): boolean;
/** Apply method, rate-limit, and content-type guards before a webhook handler reads the body. */
export declare function applyBasicWebhookRequestGuards(params: {
    req: IncomingMessage;
    res: ServerResponse;
    allowMethods?: readonly string[];
    rateLimiter?: FixedWindowRateLimiter;
    rateLimitKey?: string;
    nowMs?: number;
    requireJsonContentType?: boolean;
}): boolean;
/** Start the shared webhook request lifecycle and return a release hook for in-flight tracking. */
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
/** Read a webhook request body with bounded size/time limits and translate failures into responses. */
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
/** Read and parse a JSON webhook body, rejecting malformed or oversized payloads consistently. */
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
