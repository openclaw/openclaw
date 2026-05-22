import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-C4sdPbS4.js";
import { l as ImageGenerationProvider } from "./types-GE_-_n1i.js";
import { t as SubsystemLogger } from "./subsystem-C8Y0zMwJ.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Bt_BMmaf.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CtkGYL3s.js";

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