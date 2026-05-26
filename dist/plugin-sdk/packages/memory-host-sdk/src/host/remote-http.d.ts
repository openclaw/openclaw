import { fetchWithSsrFGuard, shouldUseEnvHttpProxyForUrl } from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./ssrf-policy.js";
export declare const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";
export declare const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined;
export declare function withRemoteHttpResponse<T>(params: {
    url: string;
    init?: RequestInit;
    signal?: AbortSignal;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
    shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
    auditContext?: string;
    onResponse: (response: Response) => Promise<T>;
}): Promise<T>;
