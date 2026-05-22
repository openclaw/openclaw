import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-xB6vnoi2.js";
import { l as ImageGenerationProvider } from "./types-BU72h8tR2.js";
import { t as SubsystemLogger } from "./subsystem-CodqpXnP.js";
import { n as getProviderEnvVars } from "./provider-env-vars-CAAlYYiB.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-BFtzjEJQ.js";

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