import { i as OpenClawConfig } from "./types.openclaw-GamulG8g.js";
import { J as GenerateVideoParams, Y as GenerateVideoRuntimeResult } from "./types-core-Ct8aDHbu.js";
import { s as VideoGenerationProvider } from "./types-vT3JzOUB.js";
import { t as SubsystemLogger } from "./subsystem-Ce5qcC5n.js";
import { n as getProviderEnvVars } from "./provider-env-vars-AktT41ea.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-9VUBN_rE.js";

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