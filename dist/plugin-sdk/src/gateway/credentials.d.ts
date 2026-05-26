import type { OpenClawConfig } from "../config/types.openclaw.js";
export { hasGatewayPasswordEnvCandidate, hasGatewayTokenEnvCandidate, trimToUndefined, } from "./credential-planner.js";
export type ExplicitGatewayAuth = {
    token?: string;
    password?: string;
};
type ResolvedGatewayCredentials = {
    token?: string;
    password?: string;
};
export type GatewayCredentialMode = "local" | "remote";
export type GatewayCredentialPrecedence = "env-first" | "config-first";
export type GatewayRemoteCredentialPrecedence = "remote-first" | "env-first";
export type GatewayRemoteCredentialFallback = "remote-env-local" | "remote-only";
export declare class GatewaySecretRefUnavailableError extends Error {
    readonly code = "GATEWAY_SECRET_REF_UNAVAILABLE";
    readonly path: string;
    constructor(path: string);
}
export declare function isGatewaySecretRefUnavailableError(error: unknown, expectedPath?: string): error is GatewaySecretRefUnavailableError;
export declare function resolveGatewayCredentialsFromValues(params: {
    configToken?: unknown;
    configPassword?: unknown;
    env?: NodeJS.ProcessEnv;
    tokenPrecedence?: GatewayCredentialPrecedence;
    passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials;
export declare function resolveGatewayCredentialsFromConfig(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
    urlOverride?: string;
    urlOverrideSource?: "cli" | "env";
    modeOverride?: GatewayCredentialMode;
    localTokenPrecedence?: GatewayCredentialPrecedence;
    localPasswordPrecedence?: GatewayCredentialPrecedence;
    remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
    remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
    remoteTokenFallback?: GatewayRemoteCredentialFallback;
    remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): ResolvedGatewayCredentials;
export declare function resolveGatewayProbeCredentialsFromConfig(params: {
    cfg: OpenClawConfig;
    mode: GatewayCredentialMode;
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
}): ResolvedGatewayCredentials;
