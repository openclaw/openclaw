import "./subagent-hooks-DhE9pdq4.js";
//#region extensions/feishu/subagent-hooks-api.ts
let feishuSubagentHooksPromise = null;
function loadFeishuSubagentHooksModule() {
	feishuSubagentHooksPromise ??= import("./subagent-hooks-DtnHsM8T.js");
	return feishuSubagentHooksPromise;
}
function registerFeishuSubagentHooks(api) {
	api.on("subagent_spawning", async (event, ctx) => {
		const { handleFeishuSubagentSpawning } = await loadFeishuSubagentHooksModule();
		return await handleFeishuSubagentSpawning(event, ctx);
	});
	api.on("subagent_delivery_target", async (event) => {
		const { handleFeishuSubagentDeliveryTarget } = await loadFeishuSubagentHooksModule();
		return handleFeishuSubagentDeliveryTarget(event);
	});
	api.on("subagent_ended", async (event) => {
		const { handleFeishuSubagentEnded } = await loadFeishuSubagentHooksModule();
		handleFeishuSubagentEnded(event);
	});
}
//#endregion
export { registerFeishuSubagentHooks as t };
