import type { BrowserContext, Page, Request } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
export type BrowserConsoleMessage = {
    type: string;
    text: string;
    timestamp: string;
    location?: {
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
    };
};
export type BrowserPageError = {
    message: string;
    name?: string;
    stack?: string;
    timestamp: string;
};
export type BrowserNetworkRequest = {
    id: string;
    timestamp: string;
    method: string;
    url: string;
    resourceType?: string;
    status?: number;
    ok?: boolean;
    failureText?: string;
};
type SnapshotForAIResult = {
    full: string;
    incremental?: string;
};
type SnapshotForAIOptions = {
    timeout?: number;
    track?: string;
};
export type WithSnapshotForAI = {
    _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};
type PageState = {
    console: BrowserConsoleMessage[];
    errors: BrowserPageError[];
    requests: BrowserNetworkRequest[];
    requestIds: WeakMap<Request, string>;
    nextRequestId: number;
    armIdUpload: number;
    armIdDialog: number;
    armIdDownload: number;
    /**
     * Role-based refs from the last role snapshot (e.g. e1/e2).
     * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
     * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
     */
    roleRefs?: Record<string, {
        role: string;
        name?: string;
        nth?: number;
    }>;
    roleRefsMode?: "role" | "aria";
    roleRefsFrameSelector?: string;
};
type RoleRefs = NonNullable<PageState["roleRefs"]>;
type ContextState = {
    traceActive: boolean;
};
export declare function rememberRoleRefsForTarget(opts: {
    cdpUrl: string;
    targetId: string;
    refs: RoleRefs;
    frameSelector?: string;
    mode?: NonNullable<PageState["roleRefsMode"]>;
}): void;
export declare function storeRoleRefsForTarget(opts: {
    page: Page;
    cdpUrl: string;
    targetId?: string;
    refs: RoleRefs;
    frameSelector?: string;
    mode: NonNullable<PageState["roleRefsMode"]>;
}): void;
export declare function restoreRoleRefsForTarget(opts: {
    cdpUrl: string;
    targetId?: string;
    page: Page;
}): void;
export declare function ensurePageState(page: Page): PageState;
export declare function ensureContextState(context: BrowserContext): ContextState;
export declare function getPageForTargetId(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<Page>;
export declare function refLocator(page: Page, ref: string): import("playwright-core").Locator;
export declare function closePlaywrightBrowserConnection(): Promise<void>;
/**
 * Best-effort cancellation for stuck page operations.
 *
 * Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
 * can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
 * not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
 * so in-flight commands fail fast and the next request reconnects transparently.
 *
 * IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
 * across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
 * instance, preventing reconnection.
 *
 * Instead we:
 * 1. Null out `cached` so the next call triggers a fresh connectOverCDP
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
export declare function forceDisconnectPlaywrightForTarget(opts: {
    cdpUrl: string;
    targetId?: string;
    reason?: string;
}): Promise<void>;
/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export declare function listPagesViaPlaywright(opts: {
    cdpUrl: string;
}): Promise<Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
}>>;
/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export declare function createPageViaPlaywright(opts: {
    cdpUrl: string;
    url: string;
    ssrfPolicy?: SsrFPolicy;
}): Promise<{
    targetId: string;
    title: string;
    url: string;
    type: string;
}>;
/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export declare function closePageByTargetIdViaPlaywright(opts: {
    cdpUrl: string;
    targetId: string;
}): Promise<void>;
/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export declare function focusPageByTargetIdViaPlaywright(opts: {
    cdpUrl: string;
    targetId: string;
}): Promise<void>;
export {};
