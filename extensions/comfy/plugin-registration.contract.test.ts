import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "comfy",
  providerIds: ["comfy"],
  imageGenerationProviderIds: ["comfy"],
  videoGenerationProviderIds: ["comfy"],
  toolNames: ["music_generate"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
