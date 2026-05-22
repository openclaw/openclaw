export type ScopeTokenProvider = {
    getAccessToken: (scope: string) => Promise<string>;
};
/** Retry a fetch with bearer tokens from the provided scopes when the unauthenticated attempt fails. */
export declare function fetchWithBearerAuthScopeFallback(params: {
    url: string;
    scopes: readonly string[];
    tokenProvider?: ScopeTokenProvider;
    fetchFn?: typeof fetch;
    requestInit?: RequestInit;
    requireHttps?: boolean;
    shouldAttachAuth?: (url: string) => boolean;
    shouldRetry?: (response: Response) => boolean;
}): Promise<Response>;
