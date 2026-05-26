import type { IncomingMessage, ServerResponse } from "node:http";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
import { type WebhookInFlightLimiter } from "./webhook-request-guards.js";
export type RegisteredWebhookTarget<T> = {
    target: T;
    unregister: () => void;
};
export type RegisterWebhookTargetOptions<T extends {
    path: string;
}> = {
    onFirstPathTarget?: (params: {
        path: string;
        target: T;
    }) => void | (() => void);
    onLastPathTargetRemoved?: (params: {
        path: string;
    }) => void;
};
type RegisterPluginHttpRouteParams = Parameters<typeof registerPluginHttpRoute>[0];
export { registerPluginHttpRoute };
export type RegisterWebhookPluginRouteOptions = Omit<RegisterPluginHttpRouteParams, "path" | "fallbackPath">;
/** Register a webhook target and lazily install the matching plugin HTTP route on first use. */
export declare function registerWebhookTargetWithPluginRoute<T extends {
    path: string;
}>(params: {
    targetsByPath: Map<string, T[]>;
    target: T;
    route: RegisterWebhookPluginRouteOptions;
    onLastPathTargetRemoved?: RegisterWebhookTargetOptions<T>["onLastPathTargetRemoved"];
}): RegisteredWebhookTarget<T>;
/** Add a normalized target to a path bucket and clean up route state when the last target leaves. */
export declare function registerWebhookTarget<T extends {
    path: string;
}>(targetsByPath: Map<string, T[]>, target: T, opts?: RegisterWebhookTargetOptions<T>): RegisteredWebhookTarget<T>;
/** Resolve all registered webhook targets for the incoming request path. */
export declare function resolveWebhookTargets<T>(req: IncomingMessage, targetsByPath: Map<string, T[]>): {
    path: string;
    targets: T[];
} | null;
/** Run common webhook guards, then dispatch only when the request path resolves to live targets. */
export declare function withResolvedWebhookRequestPipeline<T>(params: {
    req: IncomingMessage;
    res: ServerResponse;
    targetsByPath: Map<string, T[]>;
    allowMethods?: readonly string[];
    rateLimiter?: FixedWindowRateLimiter;
    rateLimitKey?: string;
    nowMs?: number;
    requireJsonContentType?: boolean;
    inFlightLimiter?: WebhookInFlightLimiter;
    inFlightKey?: string | ((args: {
        req: IncomingMessage;
        path: string;
        targets: T[];
    }) => string);
    inFlightLimitStatusCode?: number;
    inFlightLimitMessage?: string;
    handle: (args: {
        path: string;
        targets: T[];
    }) => Promise<boolean | void> | boolean | void;
}): Promise<boolean>;
export type WebhookTargetMatchResult<T> = {
    kind: "none";
} | {
    kind: "single";
    target: T;
} | {
    kind: "ambiguous";
};
/** Match exactly one synchronous target or report whether resolution was empty or ambiguous. */
export declare function resolveSingleWebhookTarget<T>(targets: readonly T[], isMatch: (target: T) => boolean): WebhookTargetMatchResult<T>;
/** Async variant of single-target resolution for auth checks that need I/O. */
export declare function resolveSingleWebhookTargetAsync<T>(targets: readonly T[], isMatch: (target: T) => Promise<boolean>): Promise<WebhookTargetMatchResult<T>>;
/** Resolve an authorized target and send the standard unauthorized or ambiguous response on failure. */
export declare function resolveWebhookTargetWithAuthOrReject<T>(params: {
    targets: readonly T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean | Promise<boolean>;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
    ambiguousStatusCode?: number;
    ambiguousMessage?: string;
}): Promise<T | null>;
/** Synchronous variant of webhook auth resolution for cheap in-memory match checks. */
export declare function resolveWebhookTargetWithAuthOrRejectSync<T>(params: {
    targets: readonly T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
    ambiguousStatusCode?: number;
    ambiguousMessage?: string;
}): T | null;
/** Reject non-POST webhook requests with the conventional Allow header. */
export declare function rejectNonPostWebhookRequest(req: IncomingMessage, res: ServerResponse): boolean;
