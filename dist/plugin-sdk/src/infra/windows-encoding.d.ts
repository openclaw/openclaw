export declare function parseWindowsCodePage(raw: string): number | null;
export declare function resolveWindowsConsoleEncoding(): string | null;
export declare function decodeWindowsOutputBuffer(params: {
    buffer: Buffer;
    platform?: NodeJS.Platform;
    windowsEncoding?: string | null;
}): string;
export declare function createWindowsOutputDecoder(params?: {
    platform?: NodeJS.Platform;
    windowsEncoding?: string | null;
}): {
    decode(chunk: Buffer | string): string;
    flush(): string;
};
