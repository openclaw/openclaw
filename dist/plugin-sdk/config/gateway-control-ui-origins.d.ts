import type { OpenClawConfig } from "./config.js";
export type GatewayNonLoopbackBindMode = "lan" | "tailnet" | "custom";
export declare function isGatewayNonLoopbackBindMode(bind: unknown): bind is GatewayNonLoopbackBindMode;
export declare function hasConfiguredControlUiAllowedOrigins(params: {
    allowedOrigins: unknown;
    dangerouslyAllowHostHeaderOriginFallback: unknown;
}): boolean;
export declare function resolveGatewayPortWithDefault(port: unknown, fallback?: number): number;
export declare function buildDefaultControlUiAllowedOrigins(params: {
    port: number;
    bind: unknown;
    customBindHost?: string;
}): string[];
export declare function ensureControlUiAllowedOriginsForNonLoopbackBind(config: OpenClawConfig, opts?: {
    defaultPort?: number;
    requireControlUiEnabled?: boolean;
}): {
    config: OpenClawConfig;
    seededOrigins: string[] | null;
    bind: GatewayNonLoopbackBindMode | null;
};
