import {
  describeOpenAiCompatibleVideo,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { MOONSHOT_BASE_URL } from "./provider-catalog.js";

// Media defaults are capability-specific and intentionally independent from chat onboarding.
const DEFAULT_MOONSHOT_IMAGE_MODEL =
  manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.image;
const DEFAULT_MOONSHOT_VIDEO_MODEL =
  manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.video;
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";

export const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "moonshot",
  capabilities: ["image", "video"],
  defaultModels: {
    image: DEFAULT_MOONSHOT_IMAGE_MODEL,
    video: DEFAULT_MOONSHOT_VIDEO_MODEL,
  },
  autoPriority: { video: 20 },
  describeImage: undefined,
  describeImages: undefined,
  describeVideo: async (params) =>
    describeOpenAiCompatibleVideo({
      ...params,
      defaultBaseUrl: MOONSHOT_BASE_URL,
      defaultModel: DEFAULT_MOONSHOT_VIDEO_MODEL,
      defaultPrompt: DEFAULT_MOONSHOT_VIDEO_PROMPT,
      provider: "moonshot",
      providerLabel: "Moonshot",
    }),
};
