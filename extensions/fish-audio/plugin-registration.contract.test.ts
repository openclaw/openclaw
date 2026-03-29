import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "fish-audio",
  speechProviderIds: ["fish-audio"],
  requireSpeechVoices: true,
});
