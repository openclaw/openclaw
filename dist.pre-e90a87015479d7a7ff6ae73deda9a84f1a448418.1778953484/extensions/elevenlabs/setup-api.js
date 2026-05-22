import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { n as migrateElevenLabsLegacyTalkConfig } from "../../config-compat-B0uz0To4.js";
//#region extensions/elevenlabs/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "elevenlabs",
	name: "ElevenLabs Setup",
	description: "Lightweight ElevenLabs setup hooks",
	register(api) {
		api.registerConfigMigration((config) => migrateElevenLabsLegacyTalkConfig(config));
	}
});
//#endregion
export { setup_api_default as default };
