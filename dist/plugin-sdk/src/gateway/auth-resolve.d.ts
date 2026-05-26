import type { GatewayAuthConfig, GatewayTailscaleMode, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
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
export type EffectiveSharedGatewayAuth = {
    mode: "token" | "password";
    secret: string | undefined;
};
export declare function resolveGatewayAuth(params: {
    authConfig?: GatewayAuthConfig | null;
    authOverride?: GatewayAuthConfig | null;
    env?: NodeJS.ProcessEnv;
    tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth;
export declare function resolveEffectiveSharedGatewayAuth(params: {
    authConfig?: GatewayAuthConfig | null;
    authOverride?: GatewayAuthConfig | null;
    env?: NodeJS.ProcessEnv;
    tailscaleMode?: GatewayTailscaleMode;
}): EffectiveSharedGatewayAuth | null;
