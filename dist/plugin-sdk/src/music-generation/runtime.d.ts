import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { getMusicGenerationProvider, listMusicGenerationProviders } from "./provider-registry.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
declare const log: import("../logging/subsystem.js").SubsystemLogger;
export type MusicGenerationRuntimeDeps = {
    getProvider?: typeof getMusicGenerationProvider;
    listProviders?: typeof listMusicGenerationProviders;
    getProviderEnvVars?: typeof getProviderEnvVars;
    log?: Pick<typeof log, "debug">;
};
export type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeMusicGenerationProviders(params?: {
    config?: OpenClawConfig;
}, deps?: MusicGenerationRuntimeDeps): import("./types.js").MusicGenerationProvider[];
export declare function generateMusic(params: GenerateMusicParams, deps?: MusicGenerationRuntimeDeps): Promise<GenerateMusicRuntimeResult>;
