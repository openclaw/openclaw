import type { OpenClawConfig } from "../config/config.js";
import type { SecretDefaults } from "./runtime-shared.js";
export declare const GATEWAY_AUTH_SURFACE_PATHS: readonly ["gateway.auth.token", "gateway.auth.password", "gateway.remote.token", "gateway.remote.password"];
export type GatewayAuthSurfacePath = (typeof GATEWAY_AUTH_SURFACE_PATHS)[number];
export type GatewayAuthSurfaceState = {
    path: GatewayAuthSurfacePath;
    active: boolean;
    reason: string;
    hasSecretRef: boolean;
};
export type GatewayAuthSurfaceStateMap = Record<GatewayAuthSurfacePath, GatewayAuthSurfaceState>;
export declare function evaluateGatewayAuthSurfaceStates(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    defaults?: SecretDefaults;
}): GatewayAuthSurfaceStateMap;
