export declare const isRunningInBrowser: () => boolean;
type Arch = 'x32' | 'x64' | 'arm' | 'arm64' | `other:${string}` | 'unknown';
type PlatformName = 'MacOS' | 'Linux' | 'Windows' | 'FreeBSD' | 'OpenBSD' | 'iOS' | 'Android' | `Other:${string}` | 'Unknown';
type Browser = 'ie' | 'edge' | 'chrome' | 'firefox' | 'safari';
type PlatformProperties = {
    'X-Stainless-Lang': 'js';
    'X-Stainless-Package-Version': string;
    'X-Stainless-OS': PlatformName;
    'X-Stainless-Arch': Arch;
    'X-Stainless-Runtime': 'node' | 'deno' | 'edge' | `browser:${Browser}` | 'unknown';
    'X-Stainless-Runtime-Version': string;
};
export declare const getPlatformHeaders: () => PlatformProperties;
export {};
//# sourceMappingURL=detect-platform.d.mts.map