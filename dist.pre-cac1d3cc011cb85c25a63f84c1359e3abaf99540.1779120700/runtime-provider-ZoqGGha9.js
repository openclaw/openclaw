import { t as resolveMemoryBackendConfig } from "./backend-config-BfH2z-GI.js";
import "./memory-core-host-runtime-files-D-15vu5K.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-Co_FUqGj.js";
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
