import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type GatewayAuthResult, type ResolvedGatewayAuth } from "./auth.js";
export declare function getHeader(req: IncomingMessage, name: string): string | undefined;
export declare function getBearerToken(req: IncomingMessage): string | undefined;
type SharedSecretGatewayAuth = Pick<ResolvedGatewayAuth, "mode">;
export type AuthorizedGatewayHttpRequest = {
    authMethod?: GatewayAuthResult["method"];
    trustDeclaredOperatorScopes: boolean;
};
export type GatewayHttpRequestAuthCheckResult = {
    ok: true;
    requestAuth: AuthorizedGatewayHttpRequest;
} | {
    ok: false;
    authResult: GatewayAuthResult;
};
export declare function resolveHttpBrowserOriginPolicy(req: IncomingMessage, cfg?: OpenClawConfig): NonNullable<Parameters<typeof authorizeHttpGatewayConnect>[0]["browserOriginPolicy"]>;
export declare function authorizeGatewayHttpRequestOrReply(params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
}): Promise<AuthorizedGatewayHttpRequest | null>;
export declare function checkGatewayHttpRequestAuth(params: {
    req: IncomingMessage;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    cfg?: OpenClawConfig;
}): Promise<GatewayHttpRequestAuthCheckResult>;
export declare function authorizeScopedGatewayHttpRequestOrReply(params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    operatorMethod: string;
    resolveOperatorScopes: (req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest) => string[];
}): Promise<{
    cfg: OpenClawConfig;
    requestAuth: AuthorizedGatewayHttpRequest;
} | null>;
export declare function isGatewayBearerHttpRequest(req: IncomingMessage, auth?: SharedSecretGatewayAuth): boolean;
export declare function resolveTrustedHttpOperatorScopes(req: IncomingMessage, authOrRequest?: SharedSecretGatewayAuth | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">): string[];
export declare function resolveOpenAiCompatibleHttpOperatorScopes(req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest): string[];
export declare function resolveHttpSenderIsOwner(req: IncomingMessage, authOrRequest?: SharedSecretGatewayAuth | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">): boolean;
export declare function resolveOpenAiCompatibleHttpSenderIsOwner(req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest): boolean;
export {};
