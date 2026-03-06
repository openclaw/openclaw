import { type LookupFn, type SsrFPolicy } from "./ssrf.js";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export declare const GUARDED_FETCH_MODE: {
    readonly STRICT: "strict";
    readonly TRUSTED_ENV_PROXY: "trusted_env_proxy";
};
export type GuardedFetchMode = (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
export type GuardedFetchOptions = {
    url: string;
    fetchImpl?: FetchLike;
    init?: RequestInit;
    maxRedirects?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    policy?: SsrFPolicy;
    lookupFn?: LookupFn;
    mode?: GuardedFetchMode;
    pinDns?: boolean;
    /** @deprecated use `mode: "trusted_env_proxy"` for trusted/operator-controlled URLs. */
    proxy?: "env";
    /**
     * @deprecated use `mode: "trusted_env_proxy"` instead.
     */
    dangerouslyAllowEnvProxyWithoutPinnedDns?: boolean;
    auditContext?: string;
};
export type GuardedFetchResult = {
    response: Response;
    finalUrl: string;
    release: () => Promise<void>;
};
type GuardedFetchPresetOptions = Omit<GuardedFetchOptions, "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns">;
export declare function withStrictGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
export declare function withTrustedEnvProxyGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
export declare function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult>;
export {};
