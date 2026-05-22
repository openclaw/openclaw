import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CoDJ5uOt.js";
//#region extensions/line/index.ts
let lineCardCommandPromise = null;
async function loadLineCardCommand(api) {
	lineCardCommandPromise ??= (async () => {
		let registered = null;
		const { registerLineCardCommand } = await import("../../card-command-BJdaATDW.js");
		registerLineCardCommand({
			...api,
			registerCommand(command) {
				registered = command;
			}
		});
		if (!registered) throw new Error("LINE card command registration unavailable");
		return registered;
	})();
	return await lineCardCommandPromise;
}
var line_default = defineBundledChannelEntry({
	id: "line",
	name: "LINE",
	description: "LINE Messaging API channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "linePlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setLineRuntime"
	},
	registerFull(api) {
		api.registerCommand({
			name: "card",
			description: "Send a rich card message (LINE).",
			acceptsArgs: true,
			requireAuth: false,
			async handler(ctx) {
				return await (await loadLineCardCommand(api)).handler(ctx);
			}
		});
	}
});
//#endregion
export { line_default as default };
