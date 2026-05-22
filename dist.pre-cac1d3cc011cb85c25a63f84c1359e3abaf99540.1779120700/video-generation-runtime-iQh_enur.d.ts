import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { J as GenerateVideoParams, Y as GenerateVideoRuntimeResult } from "./types-core-DDZhpNYe.js";
import { s as VideoGenerationProvider } from "./types-BLNWWh2p.js";
import { t as SubsystemLogger } from "./subsystem-BDulbhZL.js";
import { n as getProviderEnvVars } from "./provider-env-vars-BP9-Poca.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-Co9M57rK.js";

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