import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
type InlineModelEntry = ModelDefinitionConfig & {
    provider: string;
    baseUrl?: string;
};
type InlineProviderConfig = {
    baseUrl?: string;
    api?: ModelDefinitionConfig["api"];
    models?: ModelDefinitionConfig[];
};
export { buildModelAliasLines };
export declare function buildInlineProviderModels(providers: Record<string, InlineProviderConfig>): InlineModelEntry[];
export declare function resolveModel(provider: string, modelId: string, agentDir?: string, cfg?: OpenClawConfig): {
    model?: Model<Api>;
    error?: string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
};
