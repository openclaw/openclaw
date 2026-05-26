type BrowserOpenCommand = {
    argv: string[] | null;
    reason?: string;
    command?: string;
};
type BrowserOpenSupport = {
    ok: boolean;
    reason?: string;
    command?: string;
};
export declare function resolveBrowserOpenCommand(): Promise<BrowserOpenCommand>;
export declare function detectBrowserOpenSupport(): Promise<BrowserOpenSupport>;
export declare function openUrl(url: string): Promise<boolean>;
export {};
