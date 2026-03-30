export declare const DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE = 2000;
export declare const DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: number;
export declare function normalizeBrowserScreenshot(buffer: Buffer, opts?: {
    maxSide?: number;
    maxBytes?: number;
}): Promise<{
    buffer: Buffer;
    contentType?: "image/jpeg";
}>;
