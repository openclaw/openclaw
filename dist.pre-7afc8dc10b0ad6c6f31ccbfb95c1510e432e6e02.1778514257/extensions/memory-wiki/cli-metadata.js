import { t as definePluginEntry } from "../../plugin-entry-DFlZXTDz.js";
//#region extensions/memory-wiki/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "memory-wiki",
	name: "Memory Wiki",
	description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
	register(api) {
		api.registerCli(async ({ program, config: appConfig }) => {
			const [{ registerWikiCli }, { resolveMemoryWikiConfig }] = await Promise.all([import("../../cli-CHNsd6Ld.js"), import("../../config-BU8Ykx7y.js")]);
			const pluginConfig = appConfig.plugins?.entries?.["memory-wiki"]?.config;
			registerWikiCli(program, resolveMemoryWikiConfig(pluginConfig), appConfig);
		}, { descriptors: [{
			name: "wiki",
			description: "Inspect and initialize the memory wiki vault",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { cli_metadata_default as default };
