export declare function parseBrowserHttpUrl(raw: string, label: string): {
    parsed: URL;
    port: number;
    normalized: string;
};
export declare function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined;
