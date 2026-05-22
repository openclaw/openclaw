import { t as resolveMemoryBackendConfig } from "./backend-config-kOvFP9qQ.js";
import "./memory-core-host-runtime-files-LrzYYNSa.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-DWuQ_6QL.js";
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
