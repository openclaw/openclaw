import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "openrouter",
  providerIds: ["openrouter"],
  mediaUnderstandingProviderIds: ["openrouter"],
  imageGenerationProviderIds: ["openrouter"],
  videoGenerationProviderIds: ["openrouter"],
  musicGenerationProviderIds: ["openrouter"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
