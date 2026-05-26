import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-CxmUEffr.js";
import { l as ImageGenerationProvider } from "./types-C-TYaOW6.js";
import { t as SubsystemLogger } from "./subsystem-BtuMklFU.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Dh_vzkBY.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-BJiKKY5e.js";

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