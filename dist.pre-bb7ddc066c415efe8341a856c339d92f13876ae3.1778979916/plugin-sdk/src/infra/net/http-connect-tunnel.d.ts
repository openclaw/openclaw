import * as tls from "node:tls";
export type HttpConnectTunnelParams = {
    proxyUrl: URL;
    targetHost: string;
    targetPort: number;
    timeoutMs?: number;
};
export declare function openHttpConnectTunnel(params: HttpConnectTunnelParams): Promise<tls.TLSSocket>;
