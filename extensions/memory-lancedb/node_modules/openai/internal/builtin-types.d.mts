export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * An alias to the builtin `RequestInit` type so we can
 * easily alias it in import statements if there are name clashes.
 *
 * https://developer.mozilla.org/docs/Web/API/RequestInit
 */
type _RequestInit = RequestInit;
/**
 * An alias to the builtin `Response` type so we can
 * easily alias it in import statements if there are name clashes.
 *
 * https://developer.mozilla.org/docs/Web/API/Response
 */
type _Response = Response;
/**
 * The type for the first argument to `fetch`.
 *
 * https://developer.mozilla.org/docs/Web/API/Window/fetch#resource
 */
type _RequestInfo = Request | URL | string;
/**
 * The type for constructing `RequestInit` Headers.
 *
 * https://developer.mozilla.org/docs/Web/API/RequestInit#setting_headers
 */
type _HeadersInit = RequestInit['headers'];
/**
 * The type for constructing `RequestInit` body.
 *
 * https://developer.mozilla.org/docs/Web/API/RequestInit#body
 */
type _BodyInit = RequestInit['body'];
/**
 * An alias to the builtin `Array<T>` type so we can
 * easily alias it in import statements if there are name clashes.
 */
type _Array<T> = Array<T>;
/**
 * An alias to the builtin `Record<K, T>` type so we can
 * easily alias it in import statements if there are name clashes.
 */
type _Record<K extends keyof any, T> = Record<K, T>;
export type { _Array as Array, _BodyInit as BodyInit, _HeadersInit as HeadersInit, _Record as Record, _RequestInfo as RequestInfo, _RequestInit as RequestInit, _Response as Response, };
/**
 * A copy of the builtin `EndingType` type as it isn't fully supported in certain
 * environments and attempting to reference the global version will error.
 *
 * https://github.com/microsoft/TypeScript/blob/49ad1a3917a0ea57f5ff248159256e12bb1cb705/src/lib/dom.generated.d.ts#L27941
 */
type EndingType = 'native' | 'transparent';
/**
 * A copy of the builtin `BlobPropertyBag` type as it isn't fully supported in certain
 * environments and attempting to reference the global version will error.
 *
 * https://github.com/microsoft/TypeScript/blob/49ad1a3917a0ea57f5ff248159256e12bb1cb705/src/lib/dom.generated.d.ts#L154
 * https://developer.mozilla.org/en-US/docs/Web/API/Blob/Blob#options
 */
export interface BlobPropertyBag {
    endings?: EndingType;
    type?: string;
}
/**
 * A copy of the builtin `FilePropertyBag` type as it isn't fully supported in certain
 * environments and attempting to reference the global version will error.
 *
 * https://github.com/microsoft/TypeScript/blob/49ad1a3917a0ea57f5ff248159256e12bb1cb705/src/lib/dom.generated.d.ts#L503
 * https://developer.mozilla.org/en-US/docs/Web/API/File/File#options
 */
export interface FilePropertyBag extends BlobPropertyBag {
    lastModified?: number;
}
//# sourceMappingURL=builtin-types.d.mts.map