import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { X as GenerateImageParams, Z as GenerateImageRuntimeResult } from "./types-core-1jHSlxmO.js";
import { l as ImageGenerationProvider } from "./types-DEWRAtL4.js";
import { t as SubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BEuO1_aw.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-G7x0L2t4.js";

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