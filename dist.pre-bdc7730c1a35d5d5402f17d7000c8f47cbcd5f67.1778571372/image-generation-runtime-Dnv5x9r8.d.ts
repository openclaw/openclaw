import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { K as GenerateImageParams, q as GenerateImageRuntimeResult } from "./types-core-0qSk-WYG.js";
import { l as ImageGenerationProvider } from "./types-oYIf6Wfq.js";
import { t as SubsystemLogger } from "./subsystem-B962FG0G.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Db8mRlwZ.js";
import { n as listImageGenerationProviders, t as getImageGenerationProvider } from "./provider-registry-CcjUw2WA.js";

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