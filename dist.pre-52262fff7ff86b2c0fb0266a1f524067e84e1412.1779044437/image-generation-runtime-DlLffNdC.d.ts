import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-DeSCCKji.js";
import { l as ImageGenerationProvider } from "./types-DTqD_Fw-.js";
import { t as SubsystemLogger } from "./subsystem-B5jYXQwj.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BcAEfWeg.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-DykXbAI4.js";

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