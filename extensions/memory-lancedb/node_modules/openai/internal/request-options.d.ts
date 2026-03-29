import { NullableHeaders } from "./headers.js";
import type { BodyInit } from "./builtin-types.js";
import { Stream } from "../core/streaming.js";
import type { HTTPMethod, MergedRequestInit } from "./types.js";
import { type HeadersLike } from "./headers.js";
export type FinalRequestOptions = RequestOptions & {
    method: HTTPMethod;
    path: string;
};
export type RequestOptions = {
    /**
     * The HTTP method for the request (e.g., 'get', 'post', 'put', 'delete').
     */
    method?: HTTPMethod;
    /**
     * The URL path for the request.
     *
     * @example "/v1/foo"
     */
    path?: string;
    /**
     * Query parameters to include in the request URL.
     */
    query?: object | undefined | null;
    /**
     * The request body. Can be a string, JSON object, FormData, or other supported types.
     */
    body?: unknown;
    /**
     * HTTP headers to include with the request. Can be a Headers object, plain object, or array of tuples.
     */
    headers?: HeadersLike;
    /**
     * The maximum number of times that the client will retry a request in case of a
     * temporary failure, like a network error or a 5XX error from the server.
     *
     * @default 2
     */
    maxRetries?: number;
    stream?: boolean | undefined;
    /**
     * The maximum amount of time (in milliseconds) that the client should wait for a response
     * from the server before timing out a single request.
     *
     * @unit milliseconds
     */
    timeout?: number;
    /**
     * Additional `RequestInit` options to be passed to the underlying `fetch` call.
     * These options will be merged with the client's default fetch options.
     */
    fetchOptions?: MergedRequestInit;
    /**
     * An AbortSignal that can be used to cancel the request.
     */
    signal?: AbortSignal | undefined | null;
    /**
     * A unique key for this request to enable idempotency.
     */
    idempotencyKey?: string;
    /**
     * Override the default base URL for this specific request.
     */
    defaultBaseURL?: string | undefined;
    __metadata?: Record<string, unknown>;
    __binaryResponse?: boolean | undefined;
    __streamClass?: typeof Stream;
    __synthesizeEventData?: boolean;
};
export type EncodedContent = {
    bodyHeaders: HeadersLike;
    body: BodyInit;
};
export type RequestEncoder = (request: {
    headers: NullableHeaders;
    body: unknown;
}) => EncodedContent;
export declare const FallbackEncoder: RequestEncoder;
//# sourceMappingURL=request-options.d.ts.map