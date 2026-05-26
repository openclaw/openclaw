import type { SsrFPolicy } from "./ssrf-policy.js";
export declare function postJson<T>(params: {
    url: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    body: unknown;
    errorPrefix: string;
    attachStatus?: boolean;
    parse: (payload: unknown) => T | Promise<T>;
}): Promise<T>;
