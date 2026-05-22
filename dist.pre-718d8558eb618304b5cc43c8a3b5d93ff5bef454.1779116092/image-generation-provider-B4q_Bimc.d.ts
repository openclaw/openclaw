import { l as ImageGenerationProvider, t as GeneratedImageAsset } from "./types-DTqD_Fw-.js";
//#region extensions/openrouter/image-generation-provider.d.ts
declare function extractOpenRouterImagesFromResponse(body: unknown, options?: {
  malformedResponseError?: string;
}): GeneratedImageAsset[];
declare function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { extractOpenRouterImagesFromResponse as n, buildOpenRouterImageGenerationProvider as t };