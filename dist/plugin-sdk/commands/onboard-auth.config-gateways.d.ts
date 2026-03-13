import type { OpenClawConfig } from "../config/config.js";
export declare function applyVercelAiGatewayProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyCloudflareAiGatewayProviderConfig(cfg: OpenClawConfig, params?: {
    accountId?: string;
    gatewayId?: string;
}): OpenClawConfig;
export declare function applyVercelAiGatewayConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyCloudflareAiGatewayConfig(cfg: OpenClawConfig, params?: {
    accountId?: string;
    gatewayId?: string;
}): OpenClawConfig;
