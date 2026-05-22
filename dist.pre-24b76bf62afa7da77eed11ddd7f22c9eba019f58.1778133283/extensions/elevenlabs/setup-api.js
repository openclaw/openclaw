import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { n as migrateElevenLabsLegacyTalkConfig } from "../../config-compat-BilAYIfB.js";
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
