import { l as ModelProviderConfig } from "./types.models-KERO8F0O.js";
//#region extensions/amazon-bedrock/discovery-shared.d.ts
declare function resolveBedrockConfigApiKey(env?: NodeJS.ProcessEnv): string | undefined;
declare function mergeImplicitBedrockProvider(params: {
  existing: ModelProviderConfig | undefined;
  implicit: ModelProviderConfig;
}): ModelProviderConfig;
//#endregion
export { resolveBedrockConfigApiKey as n, mergeImplicitBedrockProvider as t };