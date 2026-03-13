import type { ResolvedBrowserConfig } from "./config.js";
export type BrowserExecutable = {
    kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
    path: string;
};
export declare function findChromeExecutableMac(): BrowserExecutable | null;
export declare function findChromeExecutableLinux(): BrowserExecutable | null;
export declare function findChromeExecutableWindows(): BrowserExecutable | null;
export declare function resolveBrowserExecutableForPlatform(resolved: ResolvedBrowserConfig, platform: NodeJS.Platform): BrowserExecutable | null;
