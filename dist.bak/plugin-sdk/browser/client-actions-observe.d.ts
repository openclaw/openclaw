import type { BrowserActionPathResult, BrowserActionTargetOk } from "./client-actions-types.js";
import type { BrowserConsoleMessage, BrowserNetworkRequest, BrowserPageError } from "./pw-session.js";
export declare function browserConsoleMessages(baseUrl: string | undefined, opts?: {
    level?: string;
    targetId?: string;
    profile?: string;
}): Promise<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
}>;
export declare function browserPdfSave(baseUrl: string | undefined, opts?: {
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionPathResult>;
export declare function browserPageErrors(baseUrl: string | undefined, opts?: {
    targetId?: string;
    clear?: boolean;
    profile?: string;
}): Promise<{
    ok: true;
    targetId: string;
    errors: BrowserPageError[];
}>;
export declare function browserRequests(baseUrl: string | undefined, opts?: {
    targetId?: string;
    filter?: string;
    clear?: boolean;
    profile?: string;
}): Promise<{
    ok: true;
    targetId: string;
    requests: BrowserNetworkRequest[];
}>;
export declare function browserTraceStart(baseUrl: string | undefined, opts?: {
    targetId?: string;
    screenshots?: boolean;
    snapshots?: boolean;
    sources?: boolean;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserTraceStop(baseUrl: string | undefined, opts?: {
    targetId?: string;
    path?: string;
    profile?: string;
}): Promise<BrowserActionPathResult>;
export declare function browserHighlight(baseUrl: string | undefined, opts: {
    ref: string;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserResponseBody(baseUrl: string | undefined, opts: {
    url: string;
    targetId?: string;
    timeoutMs?: number;
    maxChars?: number;
    profile?: string;
}): Promise<{
    ok: true;
    targetId: string;
    response: {
        url: string;
        status?: number;
        headers?: Record<string, string>;
        body: string;
        truncated?: boolean;
    };
}>;
