import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import "../../api-CTcQmZyS.js";
import { n as migrateMemoryWikiLegacyConfig } from "../../config-compat-DAJ6tp7b.js";
//#region extensions/memory-wiki/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "memory-wiki",
	name: "Memory Wiki Setup",
	description: "Lightweight Memory Wiki setup hooks",
	register(api) {
		api.registerConfigMigration((config) => migrateMemoryWikiLegacyConfig(config));
	}
});
//#endregion
export { setup_api_default as default };
