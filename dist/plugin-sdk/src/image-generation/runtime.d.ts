import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
declare const log: import("../logging/subsystem.js").SubsystemLogger;
export type ImageGenerationRuntimeDeps = {
    getProvider?: typeof getImageGenerationProvider;
    listProviders?: typeof listImageGenerationProviders;
    getProviderEnvVars?: typeof getProviderEnvVars;
    log?: Pick<typeof log, "warn">;
};
export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeImageGenerationProviders(params?: {
    config?: OpenClawConfig;
}, deps?: ImageGenerationRuntimeDeps): import("./types.js").ImageGenerationProvider[];
export declare function generateImage(params: GenerateImageParams, deps?: ImageGenerationRuntimeDeps): Promise<GenerateImageRuntimeResult>;
