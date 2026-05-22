import { i as OpenClawConfig } from "./types.openclaw-DBDmmaVM.js";
import { J as GenerateVideoParams, Y as GenerateVideoRuntimeResult } from "./types-core-DNRcqjn0.js";
import { s as VideoGenerationProvider } from "./types-BmMJSd9Y.js";
import { t as SubsystemLogger } from "./subsystem-BgFPU4mP.js";
import { n as getProviderEnvVars } from "./provider-env-vars-B312FMUK.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-B72DrzA3.js";

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