import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "duckduckgo",
  webSearchProviderIds: ["duckduckgo"],
});
