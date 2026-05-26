export type BrowserExecutable = {
    kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
    path: string;
};
export declare function resolveGoogleChromeExecutableForPlatform(platform: NodeJS.Platform): BrowserExecutable | null;
export declare function readBrowserVersion(executablePath: string): string | null;
export declare function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null;
