import type { OpenClawConfig } from "../config/config.js";
export type ExplicitGatewayAuth = {
    token?: string;
    password?: string;
};
export type ResolvedGatewayCredentials = {
    token?: string;
    password?: string;
};
export type GatewayCredentialMode = "local" | "remote";
export type GatewayCredentialPrecedence = "env-first" | "config-first";
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";
export declare function trimToUndefined(value: unknown): string | undefined;
export declare function resolveGatewayCredentialsFromValues(params: {
    configToken?: string;
    configPassword?: string;
    env?: NodeJS.ProcessEnv;
    includeLegacyEnv?: boolean;
    tokenPrecedence?: GatewayCredentialPrecedence;
    passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials;
export declare function resolveGatewayCredentialsFromConfig(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
    urlOverride?: string;
    modeOverride?: GatewayCredentialMode;
    includeLegacyEnv?: boolean;
    localTokenPrecedence?: GatewayCredentialPrecedence;
    localPasswordPrecedence?: GatewayCredentialPrecedence;
    remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
    remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
    remoteTokenFallback?: GatewayRemoteCredentialFallback;
    remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials;
