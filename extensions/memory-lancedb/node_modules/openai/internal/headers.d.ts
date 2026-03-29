type HeaderValue = string | undefined | null;
export type HeadersLike = Headers | readonly HeaderValue[][] | Record<string, HeaderValue | readonly HeaderValue[]> | undefined | null | NullableHeaders;
declare const brand_privateNullableHeaders: unique symbol;
/**
 * @internal
 * Users can pass explicit nulls to unset default headers. When we parse them
 * into a standard headers type we need to preserve that information.
 */
export type NullableHeaders = {
    /** Brand check, prevent users from creating a NullableHeaders. */
    [brand_privateNullableHeaders]: true;
    /** Parsed headers. */
    values: Headers;
    /** Set of lowercase header names explicitly set to null. */
    nulls: Set<string>;
};
export declare const buildHeaders: (newHeaders: HeadersLike[]) => NullableHeaders;
export declare const isEmptyHeaders: (headers: HeadersLike) => boolean;
export {};
//# sourceMappingURL=headers.d.ts.map