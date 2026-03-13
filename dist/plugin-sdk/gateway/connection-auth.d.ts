import type { OpenClawConfig } from "../config/config.js";
import type { ExplicitGatewayAuth } from "./call.js";
import type { GatewayCredentialMode, GatewayCredentialPrecedence, GatewayRemoteCredentialFallback, GatewayRemoteCredentialPrecedence } from "./credentials.js";
export type GatewayConnectionAuthOptions = {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
    urlOverride?: string;
    urlOverrideSource?: "cli" | "env";
    modeOverride?: GatewayCredentialMode;
    includeLegacyEnv?: boolean;
    localTokenPrecedence?: GatewayCredentialPrecedence;
    localPasswordPrecedence?: GatewayCredentialPrecedence;
    remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
    remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
    remoteTokenFallback?: GatewayRemoteCredentialFallback;
    remotePasswordFallback?: GatewayRemoteCredentialFallback;
};
export declare function resolveGatewayConnectionAuth(params: GatewayConnectionAuthOptions): Promise<{
    token?: string;
    password?: string;
}>;
export declare function resolveGatewayConnectionAuthFromConfig(params: Omit<GatewayConnectionAuthOptions, "config"> & {
    cfg: OpenClawConfig;
}): {
    token?: string;
    password?: string;
};
