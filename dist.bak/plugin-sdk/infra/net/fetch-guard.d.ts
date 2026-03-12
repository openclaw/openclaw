import { type LookupFn, type SsrFPolicy } from "./ssrf.js";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GuardedFetchOptions = {
    url: string;
    fetchImpl?: FetchLike;
    init?: RequestInit;
    maxRedirects?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    policy?: SsrFPolicy;
    lookupFn?: LookupFn;
    pinDns?: boolean;
    proxy?: "env";
    auditContext?: string;
};
export type GuardedFetchResult = {
    response: Response;
    finalUrl: string;
    release: () => Promise<void>;
};
export declare function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult>;
export {};
