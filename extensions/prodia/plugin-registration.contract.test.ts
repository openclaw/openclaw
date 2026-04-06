import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "prodia",
  imageGenerationProviderIds: ["prodia"],
  videoGenerationProviderIds: ["prodia"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
