import type { OpenClawConfig } from "../config/config.js";
export { resolveOllamaApiBase } from "./ollama-models.js";
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
export declare function buildVeniceProvider(): Promise<ProviderConfig>;
export declare function buildOllamaProvider(configuredBaseUrl?: string, opts?: {
    quiet?: boolean;
}): Promise<ProviderConfig>;
export declare function buildHuggingfaceProvider(discoveryApiKey?: string): Promise<ProviderConfig>;
export declare function buildVercelAiGatewayProvider(): Promise<ProviderConfig>;
export declare function buildVllmProvider(params?: {
    baseUrl?: string;
    apiKey?: string;
}): Promise<ProviderConfig>;
export declare function buildSglangProvider(params?: {
    baseUrl?: string;
    apiKey?: string;
}): Promise<ProviderConfig>;
/**
 * Build the Kilocode provider with dynamic model discovery from the gateway
 * API. Falls back to the static catalog on failure.
 */
export declare function buildKilocodeProviderWithDiscovery(): Promise<ProviderConfig>;
