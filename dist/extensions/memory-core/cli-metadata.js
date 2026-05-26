import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../core-kXuNbs5U.js";
//#region extensions/memory-core/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "memory-core",
	name: "Memory (Core)",
	description: "File-backed memory search tools and CLI",
	register(api) {
		api.registerCli(async ({ program }) => {
			const { registerMemoryCli } = await import("./cli.js");
			registerMemoryCli(program);
		}, { descriptors: [{
			name: "memory",
			description: "Search, inspect, and reindex memory files",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { cli_metadata_default as default };
