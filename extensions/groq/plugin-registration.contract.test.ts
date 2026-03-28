import { describePluginRegistrationContract } from "../../test/helpers/extensions/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "groq",
  mediaUnderstandingProviderIds: ["groq"],
});
