import type { OpenClawConfig } from "../config/config.js";
export { buildKimiCodingProvider, buildKilocodeProvider, buildNvidiaProvider, buildModelStudioProvider, buildQianfanProvider, buildXiaomiProvider, MODELSTUDIO_BASE_URL, MODELSTUDIO_DEFAULT_MODEL_ID, QIANFAN_BASE_URL, QIANFAN_DEFAULT_MODEL_ID, XIAOMI_DEFAULT_MODEL_ID, } from "./models-config.providers.static.js";
export { resolveOllamaApiBase } from "./models-config.providers.discovery.js";
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type SecretDefaults = {
    env?: string;
    file?: string;
    exec?: string;
};
export declare function normalizeGoogleModelId(id: string): string;
export declare function normalizeAntigravityModelId(id: string): string;
export declare function enforceSourceManagedProviderSecrets(params: {
    providers: ModelsConfig["providers"];
    sourceProviders: ModelsConfig["providers"] | undefined;
    sourceSecretDefaults?: SecretDefaults;
    secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"];
export declare function normalizeProviders(params: {
    providers: ModelsConfig["providers"];
    agentDir: string;
    env?: NodeJS.ProcessEnv;
    secretDefaults?: SecretDefaults;
    sourceProviders?: ModelsConfig["providers"];
    sourceSecretDefaults?: SecretDefaults;
    secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"];
type ImplicitProviderParams = {
    agentDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    explicitProviders?: Record<string, ProviderConfig> | null;
};
export declare function resolveImplicitProviders(params: ImplicitProviderParams): Promise<ModelsConfig["providers"]>;
export declare function resolveImplicitCopilotProvider(params: {
    agentDir: string;
    env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null>;
export declare function resolveImplicitBedrockProvider(params: {
    agentDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null>;
