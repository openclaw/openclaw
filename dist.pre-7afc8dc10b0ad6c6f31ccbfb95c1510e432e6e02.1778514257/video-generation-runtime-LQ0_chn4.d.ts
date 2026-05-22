import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-aEWdlOh5.js";
import { s as VideoGenerationProvider } from "./types-CkTqub04.js";
import { t as SubsystemLogger } from "./subsystem-ET63bTu_.js";
import { n as getProviderEnvVars } from "./provider-env-vars-C1N6TNuu.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-C9bL0zTq.js";

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