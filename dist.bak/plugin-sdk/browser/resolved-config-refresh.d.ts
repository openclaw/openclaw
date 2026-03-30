import { type ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.types.js";
export declare function refreshResolvedBrowserConfigFromDisk(params: {
    current: BrowserServerState;
    refreshConfigFromDisk: boolean;
    mode: "cached" | "fresh";
}): void;
export declare function resolveBrowserProfileWithHotReload(params: {
    current: BrowserServerState;
    refreshConfigFromDisk: boolean;
    name: string;
}): ResolvedBrowserProfile | null;
