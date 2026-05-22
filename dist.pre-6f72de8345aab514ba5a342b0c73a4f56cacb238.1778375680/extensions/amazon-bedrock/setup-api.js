import { t as definePluginEntry } from "../../plugin-entry-CEeEexhG.js";
import { n as resolveBedrockConfigApiKey } from "../../discovery-shared-C1Lnx880.js";
import { t as migrateAmazonBedrockLegacyConfig } from "../../config-compat-sEJqxQiM.js";
//#region extensions/amazon-bedrock/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "amazon-bedrock",
	name: "Amazon Bedrock Setup",
	description: "Lightweight Amazon Bedrock setup hooks",
	register(api) {
		api.registerProvider({
			id: "amazon-bedrock",
			label: "Amazon Bedrock",
			auth: [],
			resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env)
		});
		api.registerConfigMigration((config) => migrateAmazonBedrockLegacyConfig(config));
	}
});
//#endregion
export { setup_api_default as default };
