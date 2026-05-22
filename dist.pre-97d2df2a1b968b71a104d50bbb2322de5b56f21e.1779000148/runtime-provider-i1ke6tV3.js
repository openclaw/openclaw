import { t as resolveMemoryBackendConfig } from "./backend-config-CeAF_S8k.js";
import "./memory-core-host-runtime-files-C_XbguFm.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-D9WkYfnH.js";
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
