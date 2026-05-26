import "./subagent-hooks-CA4zbkFk.js";
//#region extensions/matrix/subagent-hooks-api.ts
let matrixSubagentHooksPromise = null;
function loadMatrixSubagentHooksModule() {
	matrixSubagentHooksPromise ??= import("./subagent-hooks-1CJToPnK.js");
	return matrixSubagentHooksPromise;
}
function registerMatrixSubagentHooks(api) {
	api.on("subagent_spawning", async (event) => {
		const { handleMatrixSubagentSpawning } = await loadMatrixSubagentHooksModule();
		return await handleMatrixSubagentSpawning(api, event);
	});
	api.on("subagent_ended", async (event) => {
		const { handleMatrixSubagentEnded } = await loadMatrixSubagentHooksModule();
		await handleMatrixSubagentEnded(event);
	});
	api.on("subagent_delivery_target", async (event) => {
		const { handleMatrixSubagentDeliveryTarget } = await loadMatrixSubagentHooksModule();
		return handleMatrixSubagentDeliveryTarget(event);
	});
}
//#endregion
export { registerMatrixSubagentHooks as t };
