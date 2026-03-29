import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "openrouter",
  providerIds: ["openrouter"],
  mediaUnderstandingProviderIds: ["openrouter"],
  requireDescribeImages: true,
});
