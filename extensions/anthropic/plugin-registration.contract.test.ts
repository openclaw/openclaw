import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
	pluginId: "anthropic",
	providerIds: ["anthropic"],
	mediaUnderstandingProviderIds: ["anthropic"],
	cliBackendIds: ["claude-cli"],
	requireDescribeImages: true,
});
