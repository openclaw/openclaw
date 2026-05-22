import type { OpenClawConfig } from "../config/types.js";
import type { MusicGenerationProviderPlugin } from "../plugins/types.js";
export declare function listMusicGenerationProviders(cfg?: OpenClawConfig): MusicGenerationProviderPlugin[];
export declare function getMusicGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): MusicGenerationProviderPlugin | undefined;
