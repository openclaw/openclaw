import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "anthropic",
  providerIds: ["anthropic"],
  mediaUnderstandingProviderIds: ["anthropic"],
  cliBackendIds: ["claude-cli"],
  requireDescribeImages: true,
});
