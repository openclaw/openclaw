import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-ru000wBe.js";
import { l as ImageGenerationProvider } from "./types-RGxZYeUC2.js";
import { t as SubsystemLogger } from "./subsystem-CodqpXnP.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DHHhLue8.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-D0zj2aku.js";

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