import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-0qSk-WYG.js";
import { s as VideoGenerationProvider } from "./types-Dz0v6vh8.js";
import { t as SubsystemLogger } from "./subsystem-B962FG0G.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Db8mRlwZ.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-C6fZ6VmI.js";

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