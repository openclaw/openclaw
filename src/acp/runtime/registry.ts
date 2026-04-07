import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { AcpRuntimeError } from "./errors.js";
import type { AcpRuntime } from "./types.js";

export type AcpRuntimeBackend = {
  id: string;
  runtime: AcpRuntime;
  healthy?: () => boolean;
};

type AcpRuntimeRegistryGlobalState = {
  backendsById: Map<string, AcpRuntimeBackend>;
};

const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");

function resolveAcpRuntimeRegistryGlobalState(): AcpRuntimeRegistryGlobalState {
  return resolveGlobalSingleton<AcpRuntimeRegistryGlobalState>(
    ACP_RUNTIME_REGISTRY_STATE_KEY,
    () => ({
      backendsById: new Map<string, AcpRuntimeBackend>(),
    }),
  );
}

const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;

function isBackendHealthy(backend: AcpRuntimeBackend): boolean {
  if (!backend.healthy) {
    return true;
  }
  try {
    return backend.healthy();
  } catch {
    return false;
  }
}

export function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void {
  const id = normalizeOptionalString(backend.id)?.toLowerCase() || "";
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

export function unregisterAcpRuntimeBackend(id: string): void {
  const normalized = normalizeOptionalString(id)?.toLowerCase() || "";
  if (!normalized) {
    return;
  }
  ACP_BACKENDS_BY_ID.delete(normalized);
}

export function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null {
  const normalized = normalizeOptionalString(id)?.toLowerCase() || "";
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

export function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend {
  const normalized = normalizeOptionalString(id)?.toLowerCase() || "";
  const backend = getAcpRuntimeBackend(normalized || undefined);
  if (!backend) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
    );
  }
  if (!isBackendHealthy(backend)) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNAVAILABLE",
      "ACP runtime backend is currently unavailable. Try again in a moment.",
    );
  }
  if (normalized && backend.id !== normalized) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      `ACP runtime backend "${normalized}" is not registered.`,
    );
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
