import { type LookupFn, type PinnedDispatcherPolicy, type SsrFPolicy } from "./ssrf.js";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export declare const GUARDED_FETCH_MODE: {
    readonly STRICT: "strict";
    readonly TRUSTED_ENV_PROXY: "trusted_env_proxy";
    readonly TRUSTED_EXPLICIT_PROXY: "trusted_explicit_proxy";
};
export type GuardedFetchMode = (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
export type GuardedFetchOptions = {
    url: string;
    fetchImpl?: FetchLike;
    init?: RequestInit;
    capture?: false | {
        flowId?: string;
        meta?: Record<string, unknown>;
    };
    maxRedirects?: number;
    /**
     * Allow replaying unsafe request methods and bodies across cross-origin redirects.
     * Sensitive cross-origin headers (for example Authorization/Cookie) are still stripped.
     * Defaults to false.
     */
    allowCrossOriginUnsafeRedirectReplay?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    requireHttps?: boolean;
    policy?: SsrFPolicy;
    lookupFn?: LookupFn;
    dispatcherPolicy?: PinnedDispatcherPolicy;
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
    refreshTimeout?: () => void;
};
type GuardedFetchPresetOptions = Omit<GuardedFetchOptions, "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns">;
export declare function withStrictGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
export declare function withTrustedEnvProxyGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
export declare function withTrustedExplicitProxyGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
export declare function retainSafeHeadersForCrossOriginRedirectHeaders(headers?: HeadersInit): Record<string, string> | undefined;
export { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";
export declare function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult>;
