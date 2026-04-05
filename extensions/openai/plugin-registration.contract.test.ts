import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "openai",
  providerIds: ["openai", "openai-codex"],
  speechProviderIds: ["openai"],
  realtimeTranscriptionProviderIds: ["openai"],
  realtimeVoiceProviderIds: ["openai"],
  mediaUnderstandingProviderIds: ["openai", "openai-codex"],
  imageGenerationProviderIds: ["openai"],
  videoGenerationProviderIds: ["openai"],
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
