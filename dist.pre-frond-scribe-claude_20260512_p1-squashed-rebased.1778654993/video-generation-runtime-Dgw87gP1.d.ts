import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-Bn6U9u2F.js";
import { s as VideoGenerationProvider } from "./types-D1yztQ8y.js";
import { t as SubsystemLogger } from "./subsystem-CVkBUUYw.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DQCUfNup.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-BWiG4jOG.js";

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