import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";
import { J as GenerateVideoParams, Y as GenerateVideoRuntimeResult } from "./types-core-Crp55Z_y.js";
import { s as VideoGenerationProvider } from "./types-CH5LU6Le.js";
import { t as SubsystemLogger } from "./subsystem-d1VSDcdo.js";
import { n as getProviderEnvVars } from "./provider-env-vars-DA7xouC9.js";
import { n as listVideoGenerationProviders, t as getVideoGenerationProvider } from "./provider-registry-B5eBn66Y.js";

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