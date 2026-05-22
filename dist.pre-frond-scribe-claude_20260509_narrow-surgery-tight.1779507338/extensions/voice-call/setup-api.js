import { c as isRecord } from "../../utils-CAcKzQHY.js";
import "../../string-coerce-runtime-CKTxkd64.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { n as migrateVoiceCallLegacyConfigInput } from "../../config-compat-8fmW7iBf.js";
//#region extensions/voice-call/setup-api.ts
function migrateVoiceCallPluginConfig(config) {
	const rawVoiceCallConfig = config.plugins?.entries?.["voice-call"]?.config;
	if (!isRecord(rawVoiceCallConfig)) return null;
	const migration = migrateVoiceCallLegacyConfigInput({
		value: rawVoiceCallConfig,
		configPathPrefix: "plugins.entries.voice-call.config"
	});
	if (migration.changes.length === 0) return null;
	const plugins = structuredClone(config.plugins ?? {});
	const entries = { ...plugins.entries };
	entries["voice-call"] = {
		...isRecord(entries["voice-call"]) ? entries["voice-call"] : {},
		config: migration.config
	};
	plugins.entries = entries;
	return {
		config: {
			...config,
			plugins
		},
		changes: migration.changes
	};
}
var setup_api_default = definePluginEntry({
	id: "voice-call",
	name: "Voice Call Setup",
	description: "Lightweight Voice Call setup hooks",
	register(api) {
		api.registerConfigMigration((config) => migrateVoiceCallPluginConfig(config));
	}
});
//#endregion
export { setup_api_default as default };
