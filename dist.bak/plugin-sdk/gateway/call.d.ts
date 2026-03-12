import type { OpenClawConfig } from "../config/config.js";
import { type GatewayClientMode, type GatewayClientName } from "../utils/message-channel.js";
import { type OperatorScope } from "./method-scopes.js";
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
    instanceId?: string;
    minProtocol?: number;
    maxProtocol?: number;
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
export type GatewayConnectionDetails = {
    url: string;
    urlSource: string;
    bindDetail?: string;
    remoteFallbackNote?: string;
    message: string;
};
export type ExplicitGatewayAuth = {
    token?: string;
    password?: string;
};
export declare function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth;
export declare function ensureExplicitGatewayAuth(params: {
    urlOverride?: string;
    auth: ExplicitGatewayAuth;
    errorHint: string;
    configPath?: string;
}): void;
export declare function buildGatewayConnectionDetails(options?: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
}): GatewayConnectionDetails;
export declare function callGatewayScoped<T = Record<string, unknown>>(opts: CallGatewayScopedOptions): Promise<T>;
export declare function callGatewayCli<T = Record<string, unknown>>(opts: CallGatewayCliOptions): Promise<T>;
export declare function callGatewayLeastPrivilege<T = Record<string, unknown>>(opts: CallGatewayBaseOptions): Promise<T>;
export declare function callGateway<T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T>;
export declare function randomIdempotencyKey(): `${string}-${string}-${string}-${string}-${string}`;
export {};
