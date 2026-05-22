import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import { t as buildClaudeMigrationProvider } from "../../provider-BOCU4sxH.js";
//#region extensions/migrate-claude/index.ts
var migrate_claude_default = definePluginEntry({
	id: "migrate-claude",
	name: "Claude Migration",
	description: "Imports Claude state into OpenClaw.",
	register(api) {
		api.registerMigrationProvider(buildClaudeMigrationProvider({ runtime: api.runtime }));
	}
});
//#endregion
export { migrate_claude_default as default };
