import type { OpenClawConfig } from "../config/config.js";
export declare function applyMinimaxProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMinimaxHostedProviderConfig(cfg: OpenClawConfig, params?: {
    baseUrl?: string;
}): OpenClawConfig;
export declare function applyMinimaxConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyMinimaxHostedConfig(cfg: OpenClawConfig, params?: {
    baseUrl?: string;
}): OpenClawConfig;
export declare function applyMinimaxApiProviderConfig(cfg: OpenClawConfig, modelId?: string): OpenClawConfig;
export declare function applyMinimaxApiConfig(cfg: OpenClawConfig, modelId?: string): OpenClawConfig;
export declare function applyMinimaxApiProviderConfigCn(cfg: OpenClawConfig, modelId?: string): OpenClawConfig;
export declare function applyMinimaxApiConfigCn(cfg: OpenClawConfig, modelId?: string): OpenClawConfig;
