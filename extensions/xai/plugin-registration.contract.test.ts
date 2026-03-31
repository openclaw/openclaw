import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "xai",
  providerIds: ["xai"],
  webSearchProviderIds: ["grok"],
});
