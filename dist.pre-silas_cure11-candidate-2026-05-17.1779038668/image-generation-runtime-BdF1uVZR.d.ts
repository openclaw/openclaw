import { i as OpenClawConfig } from "./types.openclaw-D8bJSZjd.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-BqOguxg5.js";
import { l as ImageGenerationProvider } from "./types-DVoANSAT.js";
import { t as SubsystemLogger } from "./subsystem-CQ9ScpqT.js";
import { n as getProviderEnvVars } from "./provider-env-vars-CS-1397R.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-B7aoMfyB.js";

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