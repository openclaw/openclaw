import { t as resolveMemoryBackendConfig } from "./backend-config-H_dmYeeS.js";
import "./memory-core-host-runtime-files-BMN5Mv9s.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-nyZ3NErf.js";
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
