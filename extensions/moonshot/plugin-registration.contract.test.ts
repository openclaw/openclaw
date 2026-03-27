import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "moonshot",
  providerIds: ["moonshot"],
  webSearchProviderIds: ["kimi"],
  mediaUnderstandingProviderIds: ["moonshot"],
  requireDescribeImages: true,
  manifestAuthChoice: {
    pluginId: "kimi",
    choiceId: "kimi-code-api-key",
    choiceLabel: "Kimi Code API key (subscription)",
    groupId: "moonshot",
    groupLabel: "Moonshot AI (Kimi K2.5)",
    groupHint: "Kimi K2.5",
  },
});
