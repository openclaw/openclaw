export type ChromeExtensionRelayServer = {
    host: string;
    bindHost: string;
    port: number;
    baseUrl: string;
    cdpWsUrl: string;
    extensionConnected: () => boolean;
    stop: () => Promise<void>;
};
export declare function getChromeExtensionRelayAuthHeaders(url: string): Record<string, string>;
export declare function ensureChromeExtensionRelayServer(opts: {
    cdpUrl: string;
    bindHost?: string;
}): Promise<ChromeExtensionRelayServer>;
export declare function stopChromeExtensionRelayServer(opts: {
    cdpUrl: string;
}): Promise<boolean>;
