import type { SsrFPolicy } from "../infra/net/ssrf.js";
export declare function postJson<T>(params: {
    url: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    body: unknown;
    errorPrefix: string;
    attachStatus?: boolean;
    parse: (payload: unknown) => T | Promise<T>;
}): Promise<T>;
