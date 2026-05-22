import { i as OpenClawConfig } from "./types.openclaw-DPnlcagS.js";
import { X as GenerateImageParams, Z as GenerateImageRuntimeResult } from "./types-core-BCt6C0U-.js";
import { l as ImageGenerationProvider } from "./types-DJRt10UN.js";
import { t as SubsystemLogger } from "./subsystem-DZafYhra.js";
import { n as getProviderEnvVars } from "./provider-env-vars-5eGDllKB.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CQp2KIqa.js";

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