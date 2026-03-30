import type { SsrFPolicy } from "../infra/net/ssrf.js";
export declare function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined;
export declare function withRemoteHttpResponse<T>(params: {
    url: string;
    init?: RequestInit;
    ssrfPolicy?: SsrFPolicy;
    auditContext?: string;
    onResponse: (response: Response) => Promise<T>;
}): Promise<T>;
