import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";
import { X as GenerateImageParams, Z as GenerateImageRuntimeResult } from "./types-core-Crp55Z_y.js";
import { l as ImageGenerationProvider } from "./types-CR8rW2kY.js";
import { t as SubsystemLogger } from "./subsystem-d1VSDcdo.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DA7xouC9.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CmsZZlO_.js";

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