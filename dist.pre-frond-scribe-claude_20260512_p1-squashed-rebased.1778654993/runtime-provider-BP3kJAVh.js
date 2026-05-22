import { t as resolveMemoryBackendConfig } from "./backend-config-CJ6cnle2.js";
import "./memory-core-host-runtime-files-B0k9HPix.js";
import { n as getMemorySearchManager, t as closeAllMemorySearchManagers } from "./memory-CGHJq4AK.js";
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
