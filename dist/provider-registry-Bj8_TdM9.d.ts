import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as ImageGenerationProviderPlugin } from "./types-Vx7Jq4_-2.js";

//#region src/image-generation/provider-registry.d.ts
declare function listImageGenerationProviders(cfg?: OpenClawConfig): ImageGenerationProviderPlugin[];
declare function getImageGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): ImageGenerationProviderPlugin | undefined;
//#endregion
export { listImageGenerationProviders as n, getImageGenerationProvider as t };