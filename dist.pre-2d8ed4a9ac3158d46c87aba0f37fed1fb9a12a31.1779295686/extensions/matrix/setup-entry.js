import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-mHGe9Hjo.js";
//#region extensions/matrix/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "matrixSetupPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-setter-api.js",
		exportName: "setMatrixRuntime"
	}
});
//#endregion
export { setup_entry_default as default };
