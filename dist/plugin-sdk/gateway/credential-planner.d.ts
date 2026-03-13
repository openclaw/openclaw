import type { OpenClawConfig } from "../config/config.js";
export type GatewayCredentialInputPath = "gateway.auth.token" | "gateway.auth.password" | "gateway.remote.token" | "gateway.remote.password";
export type GatewayConfiguredCredentialInput = {
    path: GatewayCredentialInputPath;
    configured: boolean;
    value?: string;
    refPath?: GatewayCredentialInputPath;
    hasSecretRef: boolean;
};
export type GatewayCredentialPlan = {
    configuredMode: "local" | "remote";
    authMode?: string;
    envToken?: string;
    envPassword?: string;
    localToken: GatewayConfiguredCredentialInput;
    localPassword: GatewayConfiguredCredentialInput;
    remoteToken: GatewayConfiguredCredentialInput;
    remotePassword: GatewayConfiguredCredentialInput;
    localTokenCanWin: boolean;
    localPasswordCanWin: boolean;
    localTokenSurfaceActive: boolean;
    tokenCanWin: boolean;
    passwordCanWin: boolean;
    remoteMode: boolean;
    remoteUrlConfigured: boolean;
    tailscaleRemoteExposure: boolean;
    remoteConfiguredSurface: boolean;
    remoteTokenFallbackActive: boolean;
    remoteTokenActive: boolean;
    remotePasswordFallbackActive: boolean;
    remotePasswordActive: boolean;
};
type GatewaySecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
export declare function trimToUndefined(value: unknown): string | undefined;
/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export declare function trimCredentialToUndefined(value: unknown): string | undefined;
export declare function readGatewayTokenEnv(env?: NodeJS.ProcessEnv, includeLegacyEnv?: boolean): string | undefined;
export declare function readGatewayPasswordEnv(env?: NodeJS.ProcessEnv, includeLegacyEnv?: boolean): string | undefined;
export declare function hasGatewayTokenEnvCandidate(env?: NodeJS.ProcessEnv, includeLegacyEnv?: boolean): boolean;
export declare function hasGatewayPasswordEnvCandidate(env?: NodeJS.ProcessEnv, includeLegacyEnv?: boolean): boolean;
export declare function createGatewayCredentialPlan(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeLegacyEnv?: boolean;
    defaults?: GatewaySecretDefaults;
}): GatewayCredentialPlan;
export {};
