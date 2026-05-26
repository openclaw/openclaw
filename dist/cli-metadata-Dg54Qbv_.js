import { t as definePluginEntry } from "./plugin-entry-CJpThfKg.js";
//#region extensions/matrix/src/cli-metadata.ts
function registerMatrixCliMetadata(api) {
	api.registerCli(async ({ program }) => {
		const { registerMatrixCli } = await import("./cli-OiyIZwai.js");
		registerMatrixCli({ program });
	}, { descriptors: [{
		name: "matrix",
		description: "Manage Matrix accounts, verification, devices, and profile state",
		hasSubcommands: true
	}] });
}
//#endregion
//#region extensions/matrix/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "matrix",
	name: "Matrix",
	description: "Matrix channel plugin (matrix-js-sdk)",
	register: registerMatrixCliMetadata
});
//#endregion
export { registerMatrixCliMetadata as n, cli_metadata_default as t };
