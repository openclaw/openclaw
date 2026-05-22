import { l as ModelProviderConfig, o as ModelDefinitionConfig, t as BedrockDiscoveryConfig } from "./types.models-KERO8F0O.js";
import { BedrockClient } from "@aws-sdk/client-bedrock";

//#region extensions/amazon-bedrock/discovery.d.ts
declare function resetBedrockDiscoveryCacheForTest(): void;
declare function discoverBedrockModels(params: {
  region: string;
  config?: BedrockDiscoveryConfig;
  now?: () => number;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelDefinitionConfig[]>;
declare function resolveImplicitBedrockProvider(params: {
  config?: {
    models?: {
      bedrockDiscovery?: BedrockDiscoveryConfig;
    };
  };
  pluginConfig?: {
    discovery?: BedrockDiscoveryConfig;
  };
  env?: NodeJS.ProcessEnv;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelProviderConfig | null>;
//#endregion
export { resetBedrockDiscoveryCacheForTest as n, resolveImplicitBedrockProvider as r, discoverBedrockModels as t };