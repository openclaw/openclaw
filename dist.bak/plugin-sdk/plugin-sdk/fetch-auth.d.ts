export type ScopeTokenProvider = {
    getAccessToken: (scope: string) => Promise<string>;
};
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
