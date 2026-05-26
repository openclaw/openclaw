import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/telegram/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	features: { legacyStateMigrations: true },
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "telegramSetupPlugin"
	},
	legacyStateMigrations: {
		specifier: "./legacy-state-migrations-api.js",
		exportName: "detectTelegramLegacyStateMigrations"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	}
});
//#endregion
export { setup_entry_default as default };
