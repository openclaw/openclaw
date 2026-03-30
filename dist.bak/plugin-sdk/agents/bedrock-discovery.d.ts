import { BedrockClient } from "@aws-sdk/client-bedrock";
import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.js";
export declare function resetBedrockDiscoveryCacheForTest(): void;
export declare function discoverBedrockModels(params: {
    region: string;
    config?: BedrockDiscoveryConfig;
    now?: () => number;
    clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelDefinitionConfig[]>;
