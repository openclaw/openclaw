import { n as ResolvedBrowserConfig } from "./config-Bwfo-mwZ.js";

//#region extensions/browser/src/browser/chrome.executables.d.ts
type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};
declare function resolveGoogleChromeExecutableForPlatform(platform: NodeJS.Platform): BrowserExecutable | null;
declare function readBrowserVersion(executablePath: string): string | null;
declare function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null;
declare function resolveBrowserExecutableForPlatform(resolved: ResolvedBrowserConfig, platform: NodeJS.Platform): BrowserExecutable | null;
//#endregion
export { resolveGoogleChromeExecutableForPlatform as a, resolveBrowserExecutableForPlatform as i, parseBrowserMajorVersion as n, readBrowserVersion as r, BrowserExecutable as t };