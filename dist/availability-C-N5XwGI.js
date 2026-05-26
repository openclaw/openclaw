import { t as getAcpRuntimeBackend } from "./registry-KuKuvijT.js";
import { r as isAcpEnabledByPolicy } from "./policy-NEiwKvt-.js";
//#region src/acp/runtime/availability.ts
function isAcpRuntimeSpawnAvailable(params) {
	if (params.sandboxed === true) return false;
	if (params.config && !isAcpEnabledByPolicy(params.config)) return false;
	const backend = getAcpRuntimeBackend(params.backendId ?? params.config?.acp?.backend);
	if (!backend) return false;
	if (!backend.healthy) return true;
	try {
		return backend.healthy();
	} catch {
		return false;
	}
}
//#endregion
export { isAcpRuntimeSpawnAvailable as t };
