import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
	pluginId: "fal",
	providerIds: ["fal"],
	imageGenerationProviderIds: ["fal"],
});
