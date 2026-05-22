import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
declare const log: import("../logging/subsystem.js").SubsystemLogger;
export type VideoGenerationRuntimeDeps = {
    getProvider?: typeof getVideoGenerationProvider;
    listProviders?: typeof listVideoGenerationProviders;
    getProviderEnvVars?: typeof getProviderEnvVars;
    log?: Pick<typeof log, "debug" | "warn">;
};
export type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeVideoGenerationProviders(params?: {
    config?: OpenClawConfig;
}, deps?: VideoGenerationRuntimeDeps): import("./types.js").VideoGenerationProvider[];
export declare function generateVideo(params: GenerateVideoParams, deps?: VideoGenerationRuntimeDeps): Promise<GenerateVideoRuntimeResult>;
