import type { ClaworksRuntime } from "./runtime-types.js";

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced sync of RBAC/Ingress policies after ObjectStore writes.
 */
export function schedulePolicySync(runtime: ClaworksRuntime, typeName: string): void {
  if (typeName !== "RbacPolicy" && typeName !== "IngressPolicy") {
    return;
  }
  const existing = debounceTimers.get(typeName);
  if (existing) {
    clearTimeout(existing);
  }
  debounceTimers.set(
    typeName,
    setTimeout(() => {
      debounceTimers.delete(typeName);
      void flushPolicySync(runtime, typeName);
    }, 500),
  );
}

async function flushPolicySync(runtime: ClaworksRuntime, typeName: string): Promise<void> {
  const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync.js");
  if (typeName === "RbacPolicy") {
    await syncRbacFromObjectStore(runtime);
  }
  if (typeName === "IngressPolicy") {
    await syncIngressFromObjectStore(runtime);
  }
}
