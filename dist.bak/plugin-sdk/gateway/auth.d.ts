import type { IncomingMessage } from "node:http";
import type { GatewayAuthConfig, GatewayTailscaleMode, GatewayTrustedProxyConfig } from "../config/config.js";
import { type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { type AuthRateLimiter } from "./auth-rate-limit.js";
export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
export type ResolvedGatewayAuthModeSource = "override" | "config" | "password" | "token" | "default";
export type ResolvedGatewayAuth = {
    mode: ResolvedGatewayAuthMode;
    modeSource?: ResolvedGatewayAuthModeSource;
    token?: string;
    password?: string;
    allowTailscale: boolean;
    trustedProxy?: GatewayTrustedProxyConfig;
};
export type GatewayAuthResult = {
    ok: boolean;
    method?: "none" | "token" | "password" | "tailscale" | "device-token" | "trusted-proxy";
    user?: string;
    reason?: string;
    /** Present when the request was blocked by the rate limiter. */
    rateLimited?: boolean;
    /** Milliseconds the client should wait before retrying (when rate-limited). */
    retryAfterMs?: number;
};
type ConnectAuth = {
    token?: string;
    password?: string;
};
export type GatewayAuthSurface = "http" | "ws-control-ui";
export type AuthorizeGatewayConnectParams = {
    auth: ResolvedGatewayAuth;
    connectAuth?: ConnectAuth | null;
    req?: IncomingMessage;
    trustedProxies?: string[];
    tailscaleWhois?: TailscaleWhoisLookup;
    /**
     * Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled.
     * WS Control UI enables it intentionally for tokenless trusted-host login.
     */
    authSurface?: GatewayAuthSurface;
    /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
    rateLimiter?: AuthRateLimiter;
    /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
    clientIp?: string;
    /** Optional limiter scope; defaults to shared-secret auth scope. */
    rateLimitScope?: string;
    /** Trust X-Real-IP only when explicitly enabled. */
    allowRealIpFallback?: boolean;
};
type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;
export declare function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[], allowRealIpFallback?: boolean): boolean;
export declare function resolveGatewayAuth(params: {
    authConfig?: GatewayAuthConfig | null;
    authOverride?: GatewayAuthConfig | null;
    env?: NodeJS.ProcessEnv;
    tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth;
export declare function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void;
export declare function authorizeGatewayConnect(params: AuthorizeGatewayConnectParams): Promise<GatewayAuthResult>;
export declare function authorizeHttpGatewayConnect(params: Omit<AuthorizeGatewayConnectParams, "authSurface">): Promise<GatewayAuthResult>;
export declare function authorizeWsControlUiGatewayConnect(params: Omit<AuthorizeGatewayConnectParams, "authSurface">): Promise<GatewayAuthResult>;
export {};
