import type { BrowserRouteContext } from "../server-context.js";
type BrowserDispatchRequest = {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
};
type BrowserDispatchResponse = {
    status: number;
    body: unknown;
};
export declare function createBrowserRouteDispatcher(ctx: BrowserRouteContext): {
    dispatch: (req: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>;
};
export type { BrowserDispatchRequest, BrowserDispatchResponse };
