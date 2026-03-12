import type { SsrFPolicy } from "../infra/net/ssrf.js";
export type InputImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};
export type InputFileExtractResult = {
    filename: string;
    text?: string;
    images?: InputImageContent[];
};
export type InputPdfLimits = {
    maxPages: number;
    maxPixels: number;
    minTextChars: number;
};
export type InputFileLimits = {
    allowUrl: boolean;
    urlAllowlist?: string[];
    allowedMimes: Set<string>;
    maxBytes: number;
    maxChars: number;
    maxRedirects: number;
    timeoutMs: number;
    pdf: InputPdfLimits;
};
export type InputFileLimitsConfig = {
    allowUrl?: boolean;
    allowedMimes?: string[];
    maxBytes?: number;
    maxChars?: number;
    maxRedirects?: number;
    timeoutMs?: number;
    pdf?: {
        maxPages?: number;
        maxPixels?: number;
        minTextChars?: number;
    };
};
export type InputImageLimits = {
    allowUrl: boolean;
    urlAllowlist?: string[];
    allowedMimes: Set<string>;
    maxBytes: number;
    maxRedirects: number;
    timeoutMs: number;
};
export type InputImageSource = {
    type: "base64" | "url";
    data?: string;
    url?: string;
    mediaType?: string;
};
export type InputFileSource = {
    type: "base64" | "url";
    data?: string;
    url?: string;
    mediaType?: string;
    filename?: string;
};
export type InputFetchResult = {
    buffer: Buffer;
    mimeType: string;
    contentType?: string;
};
export declare const DEFAULT_INPUT_IMAGE_MIMES: string[];
export declare const DEFAULT_INPUT_FILE_MIMES: string[];
export declare const DEFAULT_INPUT_IMAGE_MAX_BYTES: number;
export declare const DEFAULT_INPUT_FILE_MAX_BYTES: number;
export declare const DEFAULT_INPUT_FILE_MAX_CHARS = 200000;
export declare const DEFAULT_INPUT_MAX_REDIRECTS = 3;
export declare const DEFAULT_INPUT_TIMEOUT_MS = 10000;
export declare const DEFAULT_INPUT_PDF_MAX_PAGES = 4;
export declare const DEFAULT_INPUT_PDF_MAX_PIXELS = 4000000;
export declare const DEFAULT_INPUT_PDF_MIN_TEXT_CHARS = 200;
export declare function normalizeMimeType(value: string | undefined): string | undefined;
export declare function parseContentType(value: string | undefined): {
    mimeType?: string;
    charset?: string;
};
export declare function normalizeMimeList(values: string[] | undefined, fallback: string[]): Set<string>;
export declare function resolveInputFileLimits(config?: InputFileLimitsConfig): InputFileLimits;
export declare function fetchWithGuard(params: {
    url: string;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    policy?: SsrFPolicy;
    auditContext?: string;
}): Promise<InputFetchResult>;
export declare function extractImageContentFromSource(source: InputImageSource, limits: InputImageLimits): Promise<InputImageContent>;
export declare function extractFileContentFromSource(params: {
    source: InputFileSource;
    limits: InputFileLimits;
}): Promise<InputFileExtractResult>;
