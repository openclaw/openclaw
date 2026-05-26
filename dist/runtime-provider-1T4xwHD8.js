import { t as resolveMemoryBackendConfig } from "./backend-config-D_DPuEOF.js";
import "./memory-core-host-runtime-files-BogSYjdG.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-B8pZzt5D.js";
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
