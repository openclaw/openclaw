import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-_mEOJ_c3.js";
import { s as VideoGenerationProvider } from "./types-DCLmHI_f.js";
import { t as SubsystemLogger } from "./subsystem-DzIJaqs3.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BCwxpBfa.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-CygGt9-r.js";

//#region src/video-generation/runtime.d.ts
declare const log: SubsystemLogger;
type VideoGenerationRuntimeDeps = {
  getProvider?: typeof getVideoGenerationProvider;
  listProviders?: typeof listVideoGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "debug" | "warn">;
};
declare function listRuntimeVideoGenerationProviders(params?: {
  config?: OpenClawConfig;
}, deps?: VideoGenerationRuntimeDeps): VideoGenerationProvider[];
declare function generateVideo(params: GenerateVideoParams, deps?: VideoGenerationRuntimeDeps): Promise<GenerateVideoRuntimeResult>;
//#endregion
export { listRuntimeVideoGenerationProviders as n, generateVideo as t };