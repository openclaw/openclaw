import http2 from "node:http2";
export declare const APNS_HTTP2_CANCEL_CODE: number;
export type ConnectApnsHttp2SessionParams = {
    authority: string;
    timeoutMs: number;
};
export type ProbeApnsHttp2ReachabilityViaProxyParams = {
    authority: string;
    proxyUrl: string;
    timeoutMs: number;
};
export type ProbeApnsHttp2ReachabilityViaProxyResult = {
    status: number;
    body: string;
    /** Raw response headers from APNs. Includes apns-id when the connection was truly tunneled to Apple. */
    responseHeaders: Record<string, string>;
};
export declare function connectApnsHttp2Session(params: ConnectApnsHttp2SessionParams): Promise<http2.ClientHttp2Session>;
export declare function probeApnsHttp2ReachabilityViaProxy(params: ProbeApnsHttp2ReachabilityViaProxyParams): Promise<ProbeApnsHttp2ReachabilityViaProxyResult>;
