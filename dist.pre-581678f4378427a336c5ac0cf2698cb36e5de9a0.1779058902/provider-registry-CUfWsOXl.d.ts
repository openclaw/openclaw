import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { Wn as VideoGenerationProviderPlugin } from "./types-Dd0yIOXW2.js";

//#region src/video-generation/provider-registry.d.ts
declare function listVideoGenerationProviders(cfg?: OpenClawConfig): VideoGenerationProviderPlugin[];
declare function getVideoGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): VideoGenerationProviderPlugin | undefined;
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };