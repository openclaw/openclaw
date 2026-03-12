import type { IncomingMessage, ServerResponse } from "node:http";
export declare const DEFAULT_WEBHOOK_MAX_BODY_BYTES: number;
export declare const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30000;
export type RequestBodyLimitErrorCode = "PAYLOAD_TOO_LARGE" | "REQUEST_BODY_TIMEOUT" | "CONNECTION_CLOSED";
type RequestBodyLimitErrorInit = {
    code: RequestBodyLimitErrorCode;
    message?: string;
};
export declare class RequestBodyLimitError extends Error {
    readonly code: RequestBodyLimitErrorCode;
    readonly statusCode: number;
    constructor(init: RequestBodyLimitErrorInit);
}
export declare function isRequestBodyLimitError(error: unknown, code?: RequestBodyLimitErrorCode): error is RequestBodyLimitError;
export declare function requestBodyErrorToText(code: RequestBodyLimitErrorCode): string;
export type ReadRequestBodyOptions = {
    maxBytes: number;
    timeoutMs?: number;
    encoding?: BufferEncoding;
};
export declare function readRequestBodyWithLimit(req: IncomingMessage, options: ReadRequestBodyOptions): Promise<string>;
export type ReadJsonBodyResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: string;
    code: RequestBodyLimitErrorCode | "INVALID_JSON";
};
export type ReadJsonBodyOptions = ReadRequestBodyOptions & {
    emptyObjectOnEmpty?: boolean;
};
export declare function readJsonBodyWithLimit(req: IncomingMessage, options: ReadJsonBodyOptions): Promise<ReadJsonBodyResult>;
export type RequestBodyLimitGuard = {
    dispose: () => void;
    isTripped: () => boolean;
    code: () => RequestBodyLimitErrorCode | null;
};
export type RequestBodyLimitGuardOptions = {
    maxBytes: number;
    timeoutMs?: number;
    responseFormat?: "json" | "text";
    responseText?: Partial<Record<RequestBodyLimitErrorCode, string>>;
};
export declare function installRequestBodyLimitGuard(req: IncomingMessage, res: ServerResponse, options: RequestBodyLimitGuardOptions): RequestBodyLimitGuard;
export {};
