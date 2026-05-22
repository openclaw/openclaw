export declare const MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE = "OpenClaw transport error: malformed_streaming_fragment";
type ErrorPayload = Record<string, unknown>;
export type ApiErrorInfo = {
    httpCode?: string;
    type?: string;
    message?: string;
    requestId?: string;
};
export declare function parseApiErrorPayload(raw?: string): ErrorPayload | null;
export declare function extractLeadingHttpStatus(raw: string): {
    code: number;
    rest: string;
} | null;
export declare function isCloudflareOrHtmlErrorPage(raw: string): boolean;
export declare function parseApiErrorInfo(raw?: string): ApiErrorInfo | null;
export declare function formatRawAssistantErrorForUi(raw?: string): string;
export {};
