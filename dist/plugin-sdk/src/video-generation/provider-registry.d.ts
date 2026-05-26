import type { OpenClawConfig } from "../config/types.js";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";
export declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
export declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
