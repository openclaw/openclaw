import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "openai",
  providerIds: ["openai", "openai-codex"],
  speechProviderIds: ["openai"],
  mediaUnderstandingProviderIds: ["openai", "openai-codex"],
  imageGenerationProviderIds: ["openai"],
  cliBackendIds: ["codex-cli"],
  requireSpeechVoices: true,
  requireDescribeImages: true,
  requireGenerateImage: true,
});
