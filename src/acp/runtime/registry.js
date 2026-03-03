import { AcpRuntimeError } from "./errors.js";
const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");
function createAcpRuntimeRegistryGlobalState() {
    return {
        backendsById: new Map(),
    };
}
function resolveAcpRuntimeRegistryGlobalState() {
    const runtimeGlobal = globalThis;
    if (!runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY]) {
        runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY] = createAcpRuntimeRegistryGlobalState();
    }
    return runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY];
}
const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;
function normalizeBackendId(id) {
    return id?.trim().toLowerCase() || "";
}
function isBackendHealthy(backend) {
    if (!backend.healthy) {
        return true;
    }
    try {
        return backend.healthy();
    }
    catch {
        return false;
    }
}
export function registerAcpRuntimeBackend(backend) {
    const id = normalizeBackendId(backend.id);
    if (!id) {
        throw new Error("ACP runtime backend id is required");
    }
    if (!backend.runtime) {
        throw new Error(`ACP runtime backend "${id}" is missing runtime implementation`);
    }
    ACP_BACKENDS_BY_ID.set(id, {
        ...backend,
        id,
    });
}
export function unregisterAcpRuntimeBackend(id) {
    const normalized = normalizeBackendId(id);
    if (!normalized) {
        return;
    }
    ACP_BACKENDS_BY_ID.delete(normalized);
}
export function getAcpRuntimeBackend(id) {
    const normalized = normalizeBackendId(id);
    if (normalized) {
        return ACP_BACKENDS_BY_ID.get(normalized) ?? null;
    }
    if (ACP_BACKENDS_BY_ID.size === 0) {
        return null;
    }
    for (const backend of ACP_BACKENDS_BY_ID.values()) {
        if (isBackendHealthy(backend)) {
            return backend;
        }
    }
    return ACP_BACKENDS_BY_ID.values().next().value ?? null;
}
export function requireAcpRuntimeBackend(id) {
    const normalized = normalizeBackendId(id);
    const backend = getAcpRuntimeBackend(normalized || undefined);
    if (!backend) {
        throw new AcpRuntimeError("ACP_BACKEND_MISSING", "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.");
    }
    if (!isBackendHealthy(backend)) {
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime backend is currently unavailable. Try again in a moment.");
    }
    if (normalized && backend.id !== normalized) {
        throw new AcpRuntimeError("ACP_BACKEND_MISSING", `ACP runtime backend "${normalized}" is not registered.`);
    }
    return backend;
}
export const __testing = {
    resetAcpRuntimeBackendsForTests() {
        ACP_BACKENDS_BY_ID.clear();
    },
    getAcpRuntimeRegistryGlobalStateForTests() {
        return resolveAcpRuntimeRegistryGlobalState();
    },
};
