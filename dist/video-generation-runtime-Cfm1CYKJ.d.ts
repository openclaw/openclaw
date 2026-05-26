import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { G as GenerateVideoRuntimeResult, W as GenerateVideoParams } from "./types-core-CxmUEffr.js";
import { s as VideoGenerationProvider } from "./types--ccZjb_I2.js";
import { t as SubsystemLogger } from "./subsystem-BtuMklFU.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Dh_vzkBY.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-Dtt5jVZq.js";

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