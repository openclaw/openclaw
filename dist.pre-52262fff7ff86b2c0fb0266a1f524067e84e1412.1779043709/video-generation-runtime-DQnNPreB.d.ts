import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-DeSCCKji.js";
import { s as VideoGenerationProvider } from "./types-DaGHwSe6.js";
import { t as SubsystemLogger } from "./subsystem-B5jYXQwj.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BcAEfWeg.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-LWMEIDgC.js";

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