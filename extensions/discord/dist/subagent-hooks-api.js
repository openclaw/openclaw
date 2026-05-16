//#region extensions/discord/subagent-hooks-api.ts
let discordSubagentHooksPromise = null;
function loadDiscordSubagentHooksModule() {
	discordSubagentHooksPromise ??= import("./subagent-hooks-4TZ3SJrh.js").then((n) => n.i);
	return discordSubagentHooksPromise;
}
function registerDiscordSubagentHooks(api) {
	api.on("subagent_spawning", async (event) => {
		const { handleDiscordSubagentSpawning } = await loadDiscordSubagentHooksModule();
		return await handleDiscordSubagentSpawning(api, event);
	});
	api.on("subagent_ended", async (event) => {
		const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
		handleDiscordSubagentEnded(event);
	});
	api.on("subagent_delivery_target", async (event) => {
		const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
		return handleDiscordSubagentDeliveryTarget(event);
	});
}
//#endregion
export { registerDiscordSubagentHooks };
