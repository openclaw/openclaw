import { describeImageWithModel } from "../../src/media-understanding/providers/image.js";
import type { MediaUnderstandingProvider } from "../../src/media-understanding/types.js";

export const zaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "zai",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};
