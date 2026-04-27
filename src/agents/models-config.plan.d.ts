import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ProviderConfig } from "./models-config.providers.js";
export type ResolveImplicitProvidersForModelsJson = (params: {
    agentDir: string;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    explicitProviders: Record<string, ProviderConfig>;
}) => Promise<Record<string, ProviderConfig>>;
export type ModelsJsonPlan = {
    action: "skip";
} | {
    action: "noop";
} | {
    action: "write";
    contents: string;
};
export declare function resolveProvidersForModelsJsonWithDeps(params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
}, deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
}): Promise<Record<string, ProviderConfig>>;
export declare function planOpenClawModelsJsonWithDeps(params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    existingRaw: string;
    existingParsed: unknown;
}, deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
}): Promise<ModelsJsonPlan>;
export declare function planOpenClawModelsJson(params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0]): Promise<ModelsJsonPlan>;
