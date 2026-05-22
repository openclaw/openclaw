import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import { t as buildHermesMigrationProvider } from "../../provider-bx0madd4.js";
//#region extensions/migrate-hermes/index.ts
var migrate_hermes_default = definePluginEntry({
	id: "migrate-hermes",
	name: "Hermes Migration",
	description: "Imports Hermes state into OpenClaw.",
	register(api) {
		api.registerMigrationProvider(buildHermesMigrationProvider({ runtime: api.runtime }));
	}
});
//#endregion
export { migrate_hermes_default as default };
