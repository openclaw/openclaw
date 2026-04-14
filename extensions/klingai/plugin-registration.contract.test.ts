import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "klingai",
  providerIds: ["klingai"],
  imageGenerationProviderIds: ["klingai"],
  videoGenerationProviderIds: ["klingai"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
