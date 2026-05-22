import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-_mEOJ_c3.js";
import { l as ImageGenerationProvider } from "./types-BZZ3yyr0.js";
import { t as SubsystemLogger } from "./subsystem-DzIJaqs3.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BCwxpBfa.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-C97fNKqM.js";

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