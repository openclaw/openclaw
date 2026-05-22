import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { X as GenerateImageParams, Z as GenerateImageRuntimeResult } from "./types-core-DDZhpNYe.js";
import { l as ImageGenerationProvider } from "./types-Cyjs8MS3.js";
import { t as SubsystemLogger } from "./subsystem-BDulbhZL.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BP9-Poca.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-DJ1xD1u_.js";

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