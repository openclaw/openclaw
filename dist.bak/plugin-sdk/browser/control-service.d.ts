import { type BrowserServerState } from "./server-context.js";
export declare function getBrowserControlState(): BrowserServerState | null;
export declare function createBrowserControlContext(): import("./server-context.types.ts").BrowserRouteContext;
export declare function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null>;
export declare function stopBrowserControlService(): Promise<void>;
