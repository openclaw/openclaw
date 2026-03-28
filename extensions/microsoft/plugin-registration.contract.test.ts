import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "microsoft",
  speechProviderIds: ["microsoft"],
  requireSpeechVoices: true,
});
