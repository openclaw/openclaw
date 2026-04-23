import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const opencodeGoMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "opencode-go",
  capabilities: ["image"],
  defaultModels: { image: "kimi-k2.6" },
  autoPriority: { image: 45 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
