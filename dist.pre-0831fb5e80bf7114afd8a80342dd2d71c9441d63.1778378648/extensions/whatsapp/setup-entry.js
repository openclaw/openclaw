import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-BbQd7eJX.js";
//#region extensions/whatsapp/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	features: {
		legacyStateMigrations: true,
		legacySessionSurfaces: true
	},
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "whatsappSetupPlugin"
	},
	legacyStateMigrations: {
		specifier: "./legacy-state-migrations-api.js",
		exportName: "detectWhatsAppLegacyStateMigrations"
	},
	legacySessionSurface: {
		specifier: "./legacy-session-surface-api.js",
		exportName: "whatsappLegacySessionSurface"
	}
});
//#endregion
export { setup_entry_default as default };
