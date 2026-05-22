import { r as loadBundledEntryExportSync, t as defineBundledChannelEntry } from "../../channel-entry-contract-u2Swc40a.js";
//#region extensions/zalouser/index.ts
function createZalouserTool(context) {
	return loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "createZalouserTool"
	})(context);
}
var zalouser_default = defineBundledChannelEntry({
	id: "zalouser",
	name: "Zalo Personal",
	description: "Zalo personal account messaging via native zca-js integration",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "zalouserPlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setZalouserRuntime"
	},
	registerFull(api) {
		api.registerTool((ctx) => createZalouserTool(ctx), { name: "zalouser" });
	}
});
//#endregion
export { zalouser_default as default };
