import type { OpenClawConfig } from "../config/config.js";
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
export declare const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
export declare const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export declare const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
/**
 * Derive the Ollama native API base URL from a configured base URL.
 *
 * Users typically configure `baseUrl` with a `/v1` suffix (e.g.
 * `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
 * The native Ollama API lives at the root (e.g. `/api/tags`), so we
 * strip the `/v1` suffix when present.
 */
export declare function resolveOllamaApiBase(configuredBaseUrl?: string): string;
export declare function normalizeGoogleModelId(id: string): string;
export declare function normalizeAntigravityModelId(id: string): string;
export declare function normalizeProviders(params: {
    providers: ModelsConfig["providers"];
    agentDir: string;
}): ModelsConfig["providers"];
export declare function buildKimiCodingProvider(): ProviderConfig;
export declare function buildXiaomiProvider(): ProviderConfig;
export declare function buildQianfanProvider(): ProviderConfig;
export declare function buildNvidiaProvider(): ProviderConfig;
export declare function buildKilocodeProvider(): ProviderConfig;
export declare function resolveImplicitProviders(params: {
    agentDir: string;
    explicitProviders?: Record<string, ProviderConfig> | null;
}): Promise<ModelsConfig["providers"]>;
export declare function resolveImplicitCopilotProvider(params: {
    agentDir: string;
    env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null>;
export declare function resolveImplicitBedrockProvider(params: {
    agentDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null>;
export {};
