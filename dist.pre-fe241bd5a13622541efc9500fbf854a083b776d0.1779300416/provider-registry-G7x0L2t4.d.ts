import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { a as ImageGenerationProviderPlugin } from "./types-Dw7_sm4q.js";

//#region src/image-generation/provider-registry.d.ts
declare function listImageGenerationProviders(cfg?: OpenClawConfig): ImageGenerationProviderPlugin[];
declare function getImageGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): ImageGenerationProviderPlugin | undefined;
//#endregion
export { listImageGenerationProviders as n, getImageGenerationProvider as t };