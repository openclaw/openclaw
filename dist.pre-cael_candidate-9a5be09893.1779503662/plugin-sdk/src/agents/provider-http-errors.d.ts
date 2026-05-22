export { asFiniteNumber } from "../shared/number-coercion.js";
export { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";
export declare function asBoolean(value: unknown): boolean | undefined;
export declare function asObject(value: unknown): Record<string, unknown> | undefined;
export declare function truncateErrorDetail(detail: string, limit?: number): string;
export declare function redactProviderErrorBody(body: string): string;
export declare function readResponseTextLimited(response: Response, limitBytes?: number): Promise<string>;
export declare function formatProviderErrorPayload(payload: unknown): string | undefined;
export type ProviderHttpErrorInfo = {
    detail?: string;
    code?: string;
    type?: string;
    body?: string;
    requestId?: string;
};
export declare function extractProviderErrorInfo(response: Response): Promise<ProviderHttpErrorInfo>;
export declare function extractProviderErrorDetail(response: Response): Promise<string | undefined>;
export declare function extractProviderRequestId(response: Response): string | undefined;
export declare class ProviderHttpError extends Error {
    readonly status: number;
    readonly statusCode: number;
    readonly code?: string;
    readonly errorCode?: string;
    readonly errorType?: string;
    readonly errorBody?: string;
    readonly requestId?: string;
    constructor(message: string, params: {
        status: number;
        code?: string;
        type?: string;
        body?: string;
        requestId?: string;
    });
}
export declare function formatProviderHttpErrorMessage(params: {
    label: string;
    status: number;
    detail?: string;
    requestId?: string;
    statusPrefix?: string;
}): string;
export declare function createProviderHttpError(response: Response, label: string, options?: {
    statusPrefix?: string;
}): Promise<Error>;
export declare function assertOkOrThrowProviderError(response: Response, label: string): Promise<void>;
export declare function assertOkOrThrowHttpError(response: Response, label: string): Promise<void>;
export declare function readProviderJsonResponse<T>(response: Response, label: string): Promise<T>;
export declare function readProviderJsonObjectResponse(response: Response, label: string): Promise<Record<string, unknown>>;
export declare function readProviderJsonArrayFieldResponse(response: Response, label: string, field: string): Promise<unknown[]>;
export declare function assertProviderBinaryResponseContent(response: Response, label: string, kind?: string): void;
export declare function readProviderBinaryResponse(response: Response, label: string, kind?: string): Promise<Uint8Array>;
