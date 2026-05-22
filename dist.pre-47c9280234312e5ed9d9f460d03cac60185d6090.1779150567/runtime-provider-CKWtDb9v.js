import { t as resolveMemoryBackendConfig } from "./backend-config-Yi9pgA-Q.js";
import "./memory-core-host-runtime-files-DbLB62JD.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-DKze9GVf.js";
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
