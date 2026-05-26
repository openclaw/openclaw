import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { n as AcpRuntimeError } from "./errors-BgH2aVJW.js";
//#region src/acp/runtime/registry.ts
const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");
function resolveAcpRuntimeRegistryGlobalState() {
	const processStore = process;
	const existing = processStore[ACP_RUNTIME_REGISTRY_STATE_KEY];
	if (existing) return existing;
	const created = resolveGlobalSingleton(ACP_RUNTIME_REGISTRY_STATE_KEY, () => ({ backendsById: /* @__PURE__ */ new Map() }));
	processStore[ACP_RUNTIME_REGISTRY_STATE_KEY] = created;
	return created;
}
const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;
function isBackendHealthy(backend) {
	if (!backend.healthy) return true;
	try {
		return backend.healthy();
	} catch {
		return false;
	}
}
function registerAcpRuntimeBackend(backend) {
	const id = normalizeOptionalLowercaseString(backend.id) || "";
	if (!id) throw new Error("ACP runtime backend id is required");
	if (!backend.runtime) throw new Error(`ACP runtime backend "${id}" is missing runtime implementation`);
	ACP_BACKENDS_BY_ID.set(id, {
		...backend,
		id
	});
}
function unregisterAcpRuntimeBackend(id) {
	const normalized = normalizeOptionalLowercaseString(id) || "";
	if (!normalized) return;
	ACP_BACKENDS_BY_ID.delete(normalized);
}
function getAcpRuntimeBackend(id) {
	const normalized = normalizeOptionalLowercaseString(id) || "";
	if (normalized) return ACP_BACKENDS_BY_ID.get(normalized) ?? null;
	if (ACP_BACKENDS_BY_ID.size === 0) return null;
	for (const backend of ACP_BACKENDS_BY_ID.values()) if (isBackendHealthy(backend)) return backend;
	return ACP_BACKENDS_BY_ID.values().next().value ?? null;
}
function requireAcpRuntimeBackend(id) {
	const normalized = normalizeOptionalLowercaseString(id) || "";
	const backend = getAcpRuntimeBackend(normalized || void 0);
	if (!backend) throw new AcpRuntimeError("ACP_BACKEND_MISSING", "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.");
	if (!isBackendHealthy(backend)) throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime backend is currently unavailable. Try again in a moment.");
	if (normalized && backend.id !== normalized) throw new AcpRuntimeError("ACP_BACKEND_MISSING", `ACP runtime backend "${normalized}" is not registered.`);
	return backend;
}
const testing = {
	resetAcpRuntimeBackendsForTests() {
		ACP_BACKENDS_BY_ID.clear();
	},
	getAcpRuntimeRegistryGlobalStateForTests() {
		return resolveAcpRuntimeRegistryGlobalState();
	}
};
//#endregion
export { unregisterAcpRuntimeBackend as a, testing as i, registerAcpRuntimeBackend as n, requireAcpRuntimeBackend as r, getAcpRuntimeBackend as t };
