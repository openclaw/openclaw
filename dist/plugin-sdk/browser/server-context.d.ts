import type { BrowserServerState, BrowserRouteContext, ContextOptions } from "./server-context.types.js";
export type { BrowserRouteContext, BrowserServerState, BrowserTab, ProfileContext, ProfileRuntimeState, ProfileStatus, } from "./server-context.types.js";
export declare function listKnownProfileNames(state: BrowserServerState): string[];
export declare function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext;
