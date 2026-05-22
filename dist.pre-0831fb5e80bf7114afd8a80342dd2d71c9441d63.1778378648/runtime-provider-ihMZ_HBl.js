import { t as resolveMemoryBackendConfig } from "./backend-config-COFf_ytu.js";
import "./memory-core-host-runtime-files-OXCb3wW0.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-aSL0TmGv.js";
//#region extensions/memory-core/src/runtime-provider.ts
const memoryRuntime = {
	async getMemorySearchManager(params) {
		const { manager, error } = await getMemorySearchManager(params);
		return {
			manager,
			error
		};
	},
	resolveMemoryBackendConfig(params) {
		return resolveMemoryBackendConfig(params);
	},
	async closeAllMemorySearchManagers() {
		await closeAllMemorySearchManagers();
	}
};
//#endregion
export { memoryRuntime as t };
