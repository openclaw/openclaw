import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Jn as VideoGenerationProviderPlugin } from "./types-Vx7Jq4_-2.js";

//#region src/video-generation/provider-registry.d.ts
declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };