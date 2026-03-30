import type { ResolvedBrowserConfig } from "./config.js";
import { type BrowserServerState } from "./server-context.js";
export declare function ensureExtensionRelayForProfiles(params: {
    resolved: ResolvedBrowserConfig;
    onWarn: (message: string) => void;
}): Promise<void>;
export declare function stopKnownBrowserProfiles(params: {
    getState: () => BrowserServerState | null;
    onWarn: (message: string) => void;
}): Promise<void>;
