import { l as ImageGenerationProvider, t as GeneratedImageAsset } from "./types-C-TYaOW6.js";
//#region extensions/openrouter/image-generation-provider.d.ts
type OpenRouterImageEntry = {
  image_url?: {
    url?: string;
  };
  imageUrl?: {
    url?: string;
  };
};
type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | unknown[] | null;
      images?: OpenRouterImageEntry[];
    };
  }>;
};
declare function extractOpenRouterImagesFromResponse(body: OpenRouterChatCompletionResponse): GeneratedImageAsset[];
declare function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { extractOpenRouterImagesFromResponse as n, buildOpenRouterImageGenerationProvider as t };