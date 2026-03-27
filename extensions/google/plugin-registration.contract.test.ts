import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "google",
  providerIds: ["google", "google-gemini-cli"],
  webSearchProviderIds: ["gemini"],
  mediaUnderstandingProviderIds: ["google"],
  imageGenerationProviderIds: ["google"],
  cliBackendIds: ["google-gemini-cli"],
  requireDescribeImages: true,
  requireGenerateImage: true,
});
