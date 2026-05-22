import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
export type ManagedProxyTlsOptions = Readonly<{
    ca?: string;
}>;
export declare function resolveManagedProxyCaFile(params: {
    config?: ProxyConfig;
    caFileOverride?: string;
}): string | undefined;
export declare function resolveManagedProxyCaFileForUrl(params: {
    proxyUrl: string | undefined;
    config?: ProxyConfig;
    caFileOverride?: string;
}): string | undefined;
export declare function loadManagedProxyTlsOptions(caFile: string | undefined): Promise<ManagedProxyTlsOptions | undefined>;
export declare function loadManagedProxyTlsOptionsSync(caFile: string | undefined): ManagedProxyTlsOptions | undefined;
