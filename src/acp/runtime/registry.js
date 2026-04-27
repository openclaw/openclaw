import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { AcpRuntimeError } from "./errors.js";
const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");
function resolveAcpRuntimeRegistryGlobalState() {
    const processStore = process;
    const existing = processStore[ACP_RUNTIME_REGISTRY_STATE_KEY];
    if (existing) {
        return existing;
    }
    const created = resolveGlobalSingleton(ACP_RUNTIME_REGISTRY_STATE_KEY, () => ({
        backendsById: new Map(),
    }));
    // ACP runtime backends are registered from bundled plugin code and read from
    // core/test code. In Vitest and Jiti, those can run in different globalThis
    // contexts while still sharing one Node process.
    processStore[ACP_RUNTIME_REGISTRY_STATE_KEY] = created;
    return created;
}
const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;
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
    const id = normalizeOptionalLowercaseString(backend.id) || "";
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
    const normalized = normalizeOptionalLowercaseString(id) || "";
    if (!normalized) {
        return;
    }
    ACP_BACKENDS_BY_ID.delete(normalized);
}
export function getAcpRuntimeBackend(id) {
    const normalized = normalizeOptionalLowercaseString(id) || "";
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
    const normalized = normalizeOptionalLowercaseString(id) || "";
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
