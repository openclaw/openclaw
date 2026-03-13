import type { ResolvedBrowserProfile } from "./config.js";
export type BrowserProfileMode = "local-managed" | "local-extension-relay" | "remote-cdp";
export type BrowserProfileCapabilities = {
    mode: BrowserProfileMode;
    isRemote: boolean;
    requiresRelay: boolean;
    requiresAttachedTab: boolean;
    usesPersistentPlaywright: boolean;
    supportsPerTabWs: boolean;
    supportsJsonTabEndpoints: boolean;
    supportsReset: boolean;
    supportsManagedTabLimit: boolean;
};
export declare function getBrowserProfileCapabilities(profile: ResolvedBrowserProfile): BrowserProfileCapabilities;
export declare function resolveDefaultSnapshotFormat(params: {
    profile: ResolvedBrowserProfile;
    hasPlaywright: boolean;
    explicitFormat?: "ai" | "aria";
    mode?: "efficient";
}): "ai" | "aria";
export declare function shouldUsePlaywrightForScreenshot(params: {
    profile: ResolvedBrowserProfile;
    wsUrl?: string;
    ref?: string;
    element?: string;
}): boolean;
export declare function shouldUsePlaywrightForAriaSnapshot(params: {
    profile: ResolvedBrowserProfile;
    wsUrl?: string;
}): boolean;
