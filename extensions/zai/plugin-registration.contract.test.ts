import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "zai",
  mediaUnderstandingProviderIds: ["zai"],
  requireDescribeImages: true,
});
