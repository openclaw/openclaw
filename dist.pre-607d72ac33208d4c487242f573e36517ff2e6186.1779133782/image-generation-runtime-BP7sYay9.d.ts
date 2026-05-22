import { i as OpenClawConfig } from "./types.openclaw-BYfkTL_f.js";
import { X as GenerateImageParams, Z as GenerateImageRuntimeResult } from "./types-core-CmalkDje.js";
import { l as ImageGenerationProvider } from "./types-CbAlS6TN.js";
import { t as SubsystemLogger } from "./subsystem-d1VSDcdo.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BtMyhUBu.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CE_qGxyz.js";

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