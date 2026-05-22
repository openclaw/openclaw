import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { Jn as VideoGenerationProviderPlugin } from "./types-Cdl1yOYR.js";

//#region src/video-generation/provider-registry.d.ts
declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };