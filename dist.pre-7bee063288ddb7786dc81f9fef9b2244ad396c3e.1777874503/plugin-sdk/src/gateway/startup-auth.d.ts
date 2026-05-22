import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth.js";
export { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
export declare function mergeGatewayAuthConfig(base?: GatewayAuthConfig, override?: GatewayAuthConfig): GatewayAuthConfig;
export declare function mergeGatewayTailscaleConfig(base?: GatewayTailscaleConfig, override?: GatewayTailscaleConfig): GatewayTailscaleConfig;
export declare function ensureGatewayStartupAuth(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    authOverride?: GatewayAuthConfig;
    tailscaleOverride?: GatewayTailscaleConfig;
    persist?: boolean;
    baseHash?: string;
}): Promise<{
    cfg: OpenClawConfig;
    auth: ReturnType<typeof resolveGatewayAuth>;
    generatedToken?: string;
    persistedGeneratedToken: boolean;
}>;
export declare function assertHooksTokenSeparateFromGatewayAuth(params: {
    cfg: OpenClawConfig;
    auth: ResolvedGatewayAuth;
}): void;
