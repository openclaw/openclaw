import { getRuntimeConfig } from "../config/io.js";
import { resolveConfigPath as resolveConfigPathFromPaths, resolveGatewayPort as resolveGatewayPortFromPaths, resolveStateDir as resolveStateDirFromPaths } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { type GatewayClientMode, type GatewayClientName } from "../utils/message-channel.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { type GatewayConnectionDetails } from "./connection-details.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { type ExplicitGatewayAuth } from "./credentials.js";
import { type OperatorScope } from "./method-scopes.js";
export type { GatewayConnectionDetails };
type CallGatewayBaseOptions = {
    url?: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    config?: OpenClawConfig;
    method: string;
    params?: unknown;
    expectFinal?: boolean;
    timeoutMs?: number;
    clientName?: GatewayClientName;
    clientDisplayName?: string;
    clientVersion?: string;
    platform?: string;
    mode?: GatewayClientMode;
    deviceIdentity?: DeviceIdentity | null;
    instanceId?: string;
    minProtocol?: number;
    maxProtocol?: number;
    requiredMethods?: string[];
    /**
     * Overrides the config path shown in connection error details.
     * Does not affect config loading; callers still control auth via opts.token/password/env/config.
     */
    configPath?: string;
};
export type CallGatewayScopedOptions = CallGatewayBaseOptions & {
    scopes: OperatorScope[];
};
export type CallGatewayCliOptions = CallGatewayBaseOptions & {
    scopes?: OperatorScope[];
};
export type CallGatewayOptions = CallGatewayBaseOptions & {
    scopes?: OperatorScope[];
};
export type GatewayTransportErrorKind = "closed" | "timeout";
export declare class GatewayTransportError extends Error {
    readonly kind: GatewayTransportErrorKind;
    readonly connectionDetails: GatewayConnectionDetails;
    readonly code?: number;
    readonly reason?: string;
    readonly timeoutMs?: number;
    constructor(params: {
        kind: GatewayTransportErrorKind;
        message: string;
        connectionDetails: GatewayConnectionDetails;
        code?: number;
        reason?: string;
        timeoutMs?: number;
    });
}
export declare function isGatewayTransportError(value: unknown): value is GatewayTransportError;
declare const defaultCreateGatewayClient: (opts: GatewayClientOptions) => GatewayClient;
declare const defaultGatewayCallDeps: {
    createGatewayClient: (opts: GatewayClientOptions) => GatewayClient;
    getRuntimeConfig: typeof getRuntimeConfig;
    loadOrCreateDeviceIdentity: typeof loadOrCreateDeviceIdentity;
    resolveGatewayPort: typeof resolveGatewayPortFromPaths;
    resolveConfigPath: typeof resolveConfigPathFromPaths;
    resolveStateDir: typeof resolveStateDirFromPaths;
    loadGatewayTlsRuntime: typeof loadGatewayTlsRuntime;
};
export declare function buildGatewayConnectionDetails(options?: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
}): GatewayConnectionDetails;
export declare const __testing: {
    setDepsForTests(deps: Partial<typeof defaultGatewayCallDeps> | undefined): void;
    setCreateGatewayClientForTests(createGatewayClient?: typeof defaultCreateGatewayClient): void;
    resetDepsForTests(): void;
};
export type { ExplicitGatewayAuth } from "./credentials.js";
export declare function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth;
export declare function ensureExplicitGatewayAuth(params: {
    urlOverride?: string;
    urlOverrideSource?: "cli" | "env";
    explicitAuth?: ExplicitGatewayAuth;
    resolvedAuth?: ExplicitGatewayAuth;
    errorHint: string;
    configPath?: string;
}): void;
export { resolveGatewayCredentialsWithSecretInputs };
export declare function callGatewayScoped<T = Record<string, unknown>>(opts: CallGatewayScopedOptions): Promise<T>;
export declare function callGatewayCli<T = Record<string, unknown>>(opts: CallGatewayCliOptions): Promise<T>;
export declare function callGatewayLeastPrivilege<T = Record<string, unknown>>(opts: CallGatewayBaseOptions): Promise<T>;
export declare function callGateway<T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T>;
export declare function randomIdempotencyKey(): `${string}-${string}-${string}-${string}-${string}`;
