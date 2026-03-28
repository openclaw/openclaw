import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "brave",
  webSearchProviderIds: ["brave"],
});
