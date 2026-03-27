import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "fal",
  providerIds: ["fal"],
  imageGenerationProviderIds: ["fal"],
});
