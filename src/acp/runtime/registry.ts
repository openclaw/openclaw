import {
  __testing as extensionHostTesting,
  getExtensionHostAcpRuntimeBackend,
  registerExtensionHostAcpRuntimeBackend,
  requireExtensionHostAcpRuntimeBackend,
  unregisterExtensionHostAcpRuntimeBackend,
  type ExtensionHostAcpRuntimeBackend,
} from "../../extension-host/acp-runtime-backend-registry.js";

export type AcpRuntimeBackend = ExtensionHostAcpRuntimeBackend;

export function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void {
  registerExtensionHostAcpRuntimeBackend(backend);
}

export function unregisterAcpRuntimeBackend(id: string): void {
  unregisterExtensionHostAcpRuntimeBackend(id);
}

export function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null {
  return getExtensionHostAcpRuntimeBackend(id);
}

export function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend {
  return requireExtensionHostAcpRuntimeBackend(id);
}

export const __testing = {
  resetAcpRuntimeBackendsForTests() {
    extensionHostTesting.resetExtensionHostAcpRuntimeBackendsForTests();
  },
  getAcpRuntimeRegistryGlobalStateForTests() {
    return extensionHostTesting.getExtensionHostAcpRuntimeRegistryGlobalStateForTests();
  },
};
