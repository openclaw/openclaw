import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-Bn6U9u2F.js";
import { l as ImageGenerationProvider } from "./types-BS7J5paV.js";
import { t as SubsystemLogger } from "./subsystem-CVkBUUYw.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DQCUfNup.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CULlqOxg.js";

//#region src/image-generation/runtime.d.ts
declare const log: SubsystemLogger;
type ImageGenerationRuntimeDeps = {
  getProvider?: typeof getImageGenerationProvider;
  listProviders?: typeof listImageGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "warn">;
};
declare function listRuntimeImageGenerationProviders(params?: {
  config?: OpenClawConfig;
}, deps?: ImageGenerationRuntimeDeps): ImageGenerationProvider[];
declare function generateImage(params: GenerateImageParams, deps?: ImageGenerationRuntimeDeps): Promise<GenerateImageRuntimeResult>;
//#endregion
export { listRuntimeImageGenerationProviders as n, generateImage as t };