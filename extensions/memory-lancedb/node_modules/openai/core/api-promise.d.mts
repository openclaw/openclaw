import { type OpenAI } from "../client.mjs";
import { type PromiseOrValue } from "../internal/types.mjs";
import { type APIResponseProps, type WithRequestID } from "../internal/parse.mjs";
/**
 * A subclass of `Promise` providing additional helper methods
 * for interacting with the SDK.
 */
export declare class APIPromise<T> extends Promise<WithRequestID<T>> {
    #private;
    private responsePromise;
    private parseResponse;
    private parsedPromise;
    constructor(client: OpenAI, responsePromise: Promise<APIResponseProps>, parseResponse?: (client: OpenAI, props: APIResponseProps) => PromiseOrValue<WithRequestID<T>>);
    _thenUnwrap<U>(transform: (data: T, props: APIResponseProps) => U): APIPromise<U>;
    /**
     * Gets the raw `Response` instance instead of parsing the response
     * data.
     *
     * If you want to parse the response body but still get the `Response`
     * instance, you can use {@link withResponse()}.
     *
     * 👋 Getting the wrong TypeScript type for `Response`?
     * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
     * to your `tsconfig.json`.
     */
    asResponse(): Promise<Response>;
    /**
     * Gets the parsed response data, the raw `Response` instance and the ID of the request,
     * returned via the X-Request-ID header which is useful for debugging requests and reporting
     * issues to OpenAI.
     *
     * If you just want to get the raw `Response` instance without parsing it,
     * you can use {@link asResponse()}.
     *
     * 👋 Getting the wrong TypeScript type for `Response`?
     * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
     * to your `tsconfig.json`.
     */
    withResponse(): Promise<{
        data: T;
        response: Response;
        request_id: string | null;
    }>;
    private parse;
    then<TResult1 = WithRequestID<T>, TResult2 = never>(onfulfilled?: ((value: WithRequestID<T>) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2>;
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<WithRequestID<T> | TResult>;
    finally(onfinally?: (() => void) | undefined | null): Promise<WithRequestID<T>>;
}
//# sourceMappingURL=api-promise.d.mts.map