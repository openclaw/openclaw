export declare class OpenAIError extends Error {
}
export declare class APIError<TStatus extends number | undefined = number | undefined, THeaders extends Headers | undefined = Headers | undefined, TError extends Object | undefined = Object | undefined> extends OpenAIError {
    /** HTTP status for the response that caused the error */
    readonly status: TStatus;
    /** HTTP headers for the response that caused the error */
    readonly headers: THeaders;
    /** JSON body of the response that caused the error */
    readonly error: TError;
    readonly code: string | null | undefined;
    readonly param: string | null | undefined;
    readonly type: string | undefined;
    readonly requestID: string | null | undefined;
    constructor(status: TStatus, error: TError, message: string | undefined, headers: THeaders);
    private static makeMessage;
    static generate(status: number | undefined, errorResponse: Object | undefined, message: string | undefined, headers: Headers | undefined): APIError;
}
export declare class APIUserAbortError extends APIError<undefined, undefined, undefined> {
    constructor({ message }?: {
        message?: string;
    });
}
export declare class APIConnectionError extends APIError<undefined, undefined, undefined> {
    constructor({ message, cause }: {
        message?: string | undefined;
        cause?: Error | undefined;
    });
}
export declare class APIConnectionTimeoutError extends APIConnectionError {
    constructor({ message }?: {
        message?: string;
    });
}
export declare class BadRequestError extends APIError<400, Headers> {
}
export declare class AuthenticationError extends APIError<401, Headers> {
}
export declare class PermissionDeniedError extends APIError<403, Headers> {
}
export declare class NotFoundError extends APIError<404, Headers> {
}
export declare class ConflictError extends APIError<409, Headers> {
}
export declare class UnprocessableEntityError extends APIError<422, Headers> {
}
export declare class RateLimitError extends APIError<429, Headers> {
}
export declare class InternalServerError extends APIError<number, Headers> {
}
export declare class LengthFinishReasonError extends OpenAIError {
    constructor();
}
export declare class ContentFilterFinishReasonError extends OpenAIError {
    constructor();
}
export declare class InvalidWebhookSignatureError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=error.d.mts.map