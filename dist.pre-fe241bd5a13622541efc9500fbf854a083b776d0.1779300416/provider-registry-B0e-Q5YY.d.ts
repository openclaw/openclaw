import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { Jn as VideoGenerationProviderPlugin } from "./types-Dw7_sm4q.js";

//#region src/video-generation/provider-registry.d.ts
declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };