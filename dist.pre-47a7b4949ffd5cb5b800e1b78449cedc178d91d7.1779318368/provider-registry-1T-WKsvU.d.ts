import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { Jn as VideoGenerationProviderPlugin } from "./types-WgmX6DKe.js";

//#region src/video-generation/provider-registry.d.ts
declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };