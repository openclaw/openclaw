import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
//#region extensions/voice-call/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "voice-call",
	name: "Voice Call",
	description: "Voice call channel plugin",
	register(api) {
		api.registerCli(() => {}, { commands: ["voicecall"] });
	}
});
//#endregion
export { cli_metadata_default as default };
