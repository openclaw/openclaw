import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-aEWdlOh5.js";
import { l as ImageGenerationProvider } from "./types-DbQGG85m.js";
import { t as SubsystemLogger } from "./subsystem-ET63bTu_.js";
import { n as getProviderEnvVars } from "./provider-env-vars-C1N6TNuu.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-DCOwEVD7.js";

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