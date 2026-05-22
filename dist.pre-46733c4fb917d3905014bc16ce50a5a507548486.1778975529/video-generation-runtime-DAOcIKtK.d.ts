import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-ru000wBe.js";
import { s as VideoGenerationProvider } from "./types-C_p6LFqB.js";
import { t as SubsystemLogger } from "./subsystem-CodqpXnP.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DHHhLue8.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-i-Mkdnl4.js";

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