import { t as resolveMemoryBackendConfig } from "./backend-config-rInS_SvG.js";
import "./memory-core-host-runtime-files-Dnj7fWx9.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-BbboYGXL.js";
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
