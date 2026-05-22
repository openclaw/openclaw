import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-BQms3m8n.js";
import { l as ImageGenerationProvider } from "./types-Bhv64Ktm.js";
import { t as SubsystemLogger } from "./subsystem-B2aVKzlE.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Cpl_XAY2.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-BeJfA0q8.js";

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