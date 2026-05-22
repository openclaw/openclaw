import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
type GatewayCredentialInputPath = "gateway.auth.token" | "gateway.auth.password" | "gateway.remote.token" | "gateway.remote.password";
type GatewayConfiguredCredentialInput = {
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
export declare const trimToUndefined: typeof normalizeOptionalString;
/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export declare function trimCredentialToUndefined(value: unknown): string | undefined;
export declare function hasGatewayTokenEnvCandidate(env?: NodeJS.ProcessEnv): boolean;
export declare function hasGatewayPasswordEnvCandidate(env?: NodeJS.ProcessEnv): boolean;
export declare function createGatewayCredentialPlan(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    defaults?: GatewaySecretDefaults;
}): GatewayCredentialPlan;
export {};
