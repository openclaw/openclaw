import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CRTBBsEQ.js";
//#region extensions/whatsapp/index.ts
var whatsapp_default = defineBundledChannelEntry({
	id: "whatsapp",
	name: "WhatsApp",
	description: "WhatsApp channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "whatsappPlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setWhatsAppRuntime"
	}
});
//#endregion
export { whatsapp_default as default };
