import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as ImageGenerationProviderPlugin } from "./types-lCXG2pW_.js";

//#region src/image-generation/provider-registry.d.ts
declare function listImageGenerationProviders(cfg?: OpenClawConfig): ImageGenerationProviderPlugin[];
declare function getImageGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): ImageGenerationProviderPlugin | undefined;
//#endregion
export { listImageGenerationProviders as n, getImageGenerationProvider as t };