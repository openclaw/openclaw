import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { n as resolveBedrockConfigApiKey } from "../../discovery-shared-wMU-gjBJ.js";
import { t as migrateAmazonBedrockLegacyConfig } from "../../config-compat-1hHfYSfG.js";
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
