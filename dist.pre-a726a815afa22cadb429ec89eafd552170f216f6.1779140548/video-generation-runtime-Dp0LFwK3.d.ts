import { i as OpenClawConfig } from "./types.openclaw-CQzDxdpQ.js";
import { J as GenerateVideoParams, Y as GenerateVideoRuntimeResult } from "./types-core-BZYGpYcV.js";
import { s as VideoGenerationProvider } from "./types-DeDIC012.js";
import { t as SubsystemLogger } from "./subsystem-CkWk-dX6.js";
import { n as getProviderEnvVars } from "./provider-env-vars-CylXlRyd.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-DBv_oiAT.js";

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