import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "openrouter",
  providerIds: ["openrouter"],
  mediaUnderstandingProviderIds: ["openrouter"],
  requireDescribeImages: true,
});
