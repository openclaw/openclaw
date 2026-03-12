export declare function responseBodyViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    url: string;
    timeoutMs?: number;
    maxChars?: number;
}): Promise<{
    url: string;
    status?: number;
    headers?: Record<string, string>;
    body: string;
    truncated?: boolean;
}>;
