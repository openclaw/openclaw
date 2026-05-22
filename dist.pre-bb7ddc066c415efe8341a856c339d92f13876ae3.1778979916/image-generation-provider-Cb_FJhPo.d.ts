import { l as ImageGenerationProvider, t as GeneratedImageAsset } from "./types-BU72h8tR2.js";
//#region extensions/openrouter/image-generation-provider.d.ts
declare function extractOpenRouterImagesFromResponse(body: unknown, options?: {
  malformedResponseError?: string;
}): GeneratedImageAsset[];
declare function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { extractOpenRouterImagesFromResponse as n, buildOpenRouterImageGenerationProvider as t };