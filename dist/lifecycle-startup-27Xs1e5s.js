import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
//#region src/channels/plugins/lifecycle-startup.ts
async function runChannelPluginStartupMaintenance(params) {
	for (const plugin of listChannelPlugins()) {
		const runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
		if (!runStartupMaintenance) continue;
		try {
			await runStartupMaintenance(params);
		} catch (err) {
			params.log.warn?.(`${params.logPrefix?.trim() || "gateway"}: ${plugin.id} startup maintenance failed; continuing: ${String(err)}`);
		}
	}
}
//#endregion
export { runChannelPluginStartupMaintenance as t };
