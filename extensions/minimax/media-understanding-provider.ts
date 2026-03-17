import { describeImageWithModel } from "../../src/media-understanding/providers/image.js";
import type { MediaUnderstandingProvider } from "../../src/media-understanding/types.js";

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax-portal",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};
