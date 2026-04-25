import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "azure-speech",
  speechProviderIds: ["azure-speech"],
  requireSpeechVoices: true,
});