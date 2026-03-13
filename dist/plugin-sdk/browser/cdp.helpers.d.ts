import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
export { isLoopbackHost };
/**
 * Returns true when the URL uses a WebSocket protocol (ws: or wss:).
 * Used to distinguish direct-WebSocket CDP endpoints
 * from HTTP(S) endpoints that require /json/version discovery.
 */
export declare function isWebSocketUrl(url: string): boolean;
export type CdpSendFn = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
export declare function getHeadersWithAuth(url: string, headers?: Record<string, string>): {
    [x: string]: string;
};
export declare function appendCdpPath(cdpUrl: string, path: string): string;
export declare function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl: string): string;
export declare function fetchJson<T>(url: string, timeoutMs?: number, init?: RequestInit): Promise<T>;
export declare function fetchCdpChecked(url: string, timeoutMs?: number, init?: RequestInit): Promise<Response>;
export declare function fetchOk(url: string, timeoutMs?: number, init?: RequestInit): Promise<void>;
export declare function openCdpWebSocket(wsUrl: string, opts?: {
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
}): WebSocket;
export declare function withCdpSocket<T>(wsUrl: string, fn: (send: CdpSendFn) => Promise<T>, opts?: {
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
}): Promise<T>;
