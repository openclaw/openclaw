import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "zai",
  mediaUnderstandingProviderIds: ["zai"],
  requireDescribeImages: true,
});
