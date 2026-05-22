import { o as getTailnetHostname } from "./tailscale-EXEW1enj.js";
import { n as getActiveMemorySearchManager } from "./memory-runtime-DLKqdTkB.js";
//#region src/commands/status.scan.deps.runtime.ts
async function getMemorySearchManager(params) {
	const { manager } = await getActiveMemorySearchManager(params);
	if (!manager) return { manager: null };
	return { manager: {
		probeVectorStoreAvailability: manager.probeVectorStoreAvailability ? async () => await manager.probeVectorStoreAvailability() : void 0,
		async probeVectorAvailability() {
			return await manager.probeVectorAvailability();
		},
		status() {
			return manager.status();
		},
		close: manager.close ? async () => await manager.close?.() : void 0
	} };
}
//#endregion
export { getMemorySearchManager, getTailnetHostname };
