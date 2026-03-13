import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
/** Resolve the correct targetId after a navigation that may trigger a renderer swap. */
export declare function resolveTargetIdAfterNavigate(opts: {
    oldTargetId: string;
    navigatedUrl: string;
    listTabs: () => Promise<Array<{
        targetId: string;
        url: string;
    }>>;
}): Promise<string>;
export declare function registerBrowserAgentSnapshotRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext): void;
