import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "microsoft",
  speechProviderIds: ["microsoft"],
  requireSpeechVoices: true,
});
