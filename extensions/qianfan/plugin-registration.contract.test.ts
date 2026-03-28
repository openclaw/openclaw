import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "qianfan",
  providerIds: ["qianfan"],
  webSearchProviderIds: ["baidu"],
});
