import { type RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
export declare class DiscordApiError extends Error {
    status: number;
    retryAfter?: number;
    constructor(message: string, status: number, retryAfter?: number);
}
type DiscordFetchOptions = {
    retry?: RetryConfig;
    label?: string;
};
type DiscordApiRequestOptions = DiscordFetchOptions & {
    body?: unknown;
    fetcher?: typeof fetch;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
};
export declare function requestDiscord<T>(path: string, token: string, options?: DiscordApiRequestOptions): Promise<T>;
export declare function fetchDiscord<T>(path: string, token: string, fetcher?: typeof fetch, options?: DiscordFetchOptions): Promise<T>;
export {};
