import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "tavily",
  webSearchProviderIds: ["tavily"],
  toolNames: ["tavily_search", "tavily_extract"],
});
