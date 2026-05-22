import { n as PinnedDispatcherPolicy, o as SsrFPolicy, t as LookupFn } from "./ssrf-skjEI_i5.js";
//#region src/infra/net/fetch-guard.d.ts
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
declare const GUARDED_FETCH_MODE: {
  readonly STRICT: "strict";
  readonly TRUSTED_ENV_PROXY: "trusted_env_proxy";
  readonly TRUSTED_EXPLICIT_PROXY: "trusted_explicit_proxy";
};
type GuardedFetchMode = (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
type GuardedFetchOptions = {
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
  pinDns?: boolean; /** @deprecated use `mode: "trusted_env_proxy"` for trusted/operator-controlled URLs. */
  proxy?: "env";
  /**
   * @deprecated use `mode: "trusted_env_proxy"` instead.
   */
  dangerouslyAllowEnvProxyWithoutPinnedDns?: boolean;
  auditContext?: string;
};
type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
  refreshTimeout?: () => void;
};
type GuardedFetchPresetOptions = Omit<GuardedFetchOptions, "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns">;
declare function withStrictGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
declare function withTrustedEnvProxyGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
declare function withTrustedExplicitProxyGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions;
declare function retainSafeHeadersForCrossOriginRedirectHeaders(headers?: HeadersInit): Record<string, string> | undefined;
declare function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult>;
//#endregion
export { fetchWithSsrFGuard as a, withTrustedEnvProxyGuardedFetchMode as c, GuardedFetchResult as i, withTrustedExplicitProxyGuardedFetchMode as l, GuardedFetchMode as n, retainSafeHeadersForCrossOriginRedirectHeaders as o, GuardedFetchOptions as r, withStrictGuardedFetchMode as s, GUARDED_FETCH_MODE as t };