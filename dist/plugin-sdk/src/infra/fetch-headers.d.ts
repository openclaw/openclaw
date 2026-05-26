export declare function normalizeHeadersInitForFetch(headers: HeadersInit | undefined): HeadersInit | undefined;
export declare function normalizeRequestInitHeadersForFetch<T extends {
    headers?: HeadersInit;
}>(init: T | undefined): T | undefined;
