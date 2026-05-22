import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayAuthResult } from "./auth.js";
/**
 * Apply baseline security headers that are safe for all response types (API JSON,
 * HTML pages, static assets, SSE streams). Headers that restrict framing or set a
 * Content-Security-Policy are intentionally omitted here because some handlers
 * (canvas host, A2UI) serve content that may be loaded inside frames.
 */
export declare function setDefaultSecurityHeaders(res: ServerResponse, opts?: {
    strictTransportSecurity?: string;
}): void;
export declare function sendJson(res: ServerResponse, status: number, body: unknown): void;
export declare function sendText(res: ServerResponse, status: number, body: string): void;
export declare function sendMethodNotAllowed(res: ServerResponse, allow?: string): void;
export declare function sendUnauthorized(res: ServerResponse): void;
export declare function sendRateLimited(res: ServerResponse, retryAfterMs?: number): void;
export declare function sendGatewayAuthFailure(res: ServerResponse, authResult: GatewayAuthResult): void;
export declare function sendInvalidRequest(res: ServerResponse, message: string): void;
export declare function readJsonBodyOrError(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<unknown>;
export declare function writeDone(res: ServerResponse): void;
export declare function setSseHeaders(res: ServerResponse): void;
export declare function watchClientDisconnect(req: IncomingMessage, res: ServerResponse, abortController: AbortController, onDisconnect?: () => void): () => void;
