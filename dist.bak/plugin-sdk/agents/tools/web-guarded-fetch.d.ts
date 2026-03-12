import { type GuardedFetchOptions, type GuardedFetchResult } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
export declare const WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY: SsrFPolicy;
type WebToolGuardedFetchOptions = Omit<GuardedFetchOptions, "proxy"> & {
    timeoutSeconds?: number;
};
export declare function fetchWithWebToolsNetworkGuard(params: WebToolGuardedFetchOptions): Promise<GuardedFetchResult>;
export declare function withWebToolsNetworkGuard<T>(params: WebToolGuardedFetchOptions, run: (result: {
    response: Response;
    finalUrl: string;
}) => Promise<T>): Promise<T>;
export {};
