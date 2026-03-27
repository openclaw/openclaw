import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "elevenlabs",
  speechProviderIds: ["elevenlabs"],
  requireSpeechVoices: true,
});
