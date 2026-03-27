import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "minimax",
  providerIds: ["minimax", "minimax-portal"],
  mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
  imageGenerationProviderIds: ["minimax", "minimax-portal"],
  requireDescribeImages: true,
  requireGenerateImage: true,
});
