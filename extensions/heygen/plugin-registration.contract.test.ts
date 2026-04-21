import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "heygen",
  videoGenerationProviderIds: ["heygen"],
  requireGenerateVideo: true,
});
