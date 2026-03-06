import type { IncomingMessage, ServerResponse } from "node:http";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
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
export type RegisterWebhookPluginRouteOptions = Omit<RegisterPluginHttpRouteParams, "path" | "fallbackPath">;
export declare function registerWebhookTargetWithPluginRoute<T extends {
    path: string;
}>(params: {
    targetsByPath: Map<string, T[]>;
    target: T;
    route: RegisterWebhookPluginRouteOptions;
    onLastPathTargetRemoved?: RegisterWebhookTargetOptions<T>["onLastPathTargetRemoved"];
}): RegisteredWebhookTarget<T>;
export declare function registerWebhookTarget<T extends {
    path: string;
}>(targetsByPath: Map<string, T[]>, target: T, opts?: RegisterWebhookTargetOptions<T>): RegisteredWebhookTarget<T>;
export declare function resolveWebhookTargets<T>(req: IncomingMessage, targetsByPath: Map<string, T[]>): {
    path: string;
    targets: T[];
} | null;
export type WebhookTargetMatchResult<T> = {
    kind: "none";
} | {
    kind: "single";
    target: T;
} | {
    kind: "ambiguous";
};
export declare function resolveSingleWebhookTarget<T>(targets: readonly T[], isMatch: (target: T) => boolean): WebhookTargetMatchResult<T>;
export declare function resolveSingleWebhookTargetAsync<T>(targets: readonly T[], isMatch: (target: T) => Promise<boolean>): Promise<WebhookTargetMatchResult<T>>;
export declare function resolveWebhookTargetWithAuthOrReject<T>(params: {
    targets: readonly T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean | Promise<boolean>;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
    ambiguousStatusCode?: number;
    ambiguousMessage?: string;
}): Promise<T | null>;
export declare function resolveWebhookTargetWithAuthOrRejectSync<T>(params: {
    targets: readonly T[];
    res: ServerResponse;
    isMatch: (target: T) => boolean;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
    ambiguousStatusCode?: number;
    ambiguousMessage?: string;
}): T | null;
export declare function rejectNonPostWebhookRequest(req: IncomingMessage, res: ServerResponse): boolean;
export {};
