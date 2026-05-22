import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { t as ImageGenerationProviderPlugin } from "./types-DKA4S1yN.js";

//#region src/image-generation/provider-registry.d.ts
declare function listImageGenerationProviders(cfg?: OpenClawConfig): ImageGenerationProviderPlugin[];
declare function getImageGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): ImageGenerationProviderPlugin | undefined;
//#endregion
export { listImageGenerationProviders as n, getImageGenerationProvider as t };