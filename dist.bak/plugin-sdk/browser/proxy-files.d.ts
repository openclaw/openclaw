export type BrowserProxyFile = {
    path: string;
    base64: string;
    mimeType?: string;
};
export declare function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined): Promise<Map<string, string>>;
export declare function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>): void;
