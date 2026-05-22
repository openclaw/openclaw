import * as tls from "node:tls";
import type { ManagedProxyTlsOptions } from "./proxy/proxy-tls.js";
export type HttpConnectTunnelParams = {
    proxyUrl: URL;
    proxyTls?: ManagedProxyTlsOptions;
    targetHost: string;
    targetPort: number;
    timeoutMs?: number;
};
export declare function openHttpConnectTunnel(params: HttpConnectTunnelParams): Promise<tls.TLSSocket>;
