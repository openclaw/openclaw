import { t as resolveMemoryBackendConfig } from "./backend-config-C06xeEP_.js";
import "./memory-core-host-runtime-files-DEvi6KR5.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-CShcXs6J.js";
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
