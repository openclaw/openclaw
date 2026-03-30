import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
	pluginId: "groq",
	mediaUnderstandingProviderIds: ["groq"],
});
