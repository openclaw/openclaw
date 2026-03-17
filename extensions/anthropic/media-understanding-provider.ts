import { describeImageWithModel } from "../../src/media-understanding/providers/image.js";
import type { MediaUnderstandingProvider } from "../../src/media-understanding/types.js";

export const anthropicMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "anthropic",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};
