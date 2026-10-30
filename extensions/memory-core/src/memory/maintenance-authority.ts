import { AsyncLocalStorage } from "node:async_hooks";

// Explicit remote maintenance carries the admitted operator authority to the
// provider effect and database publication owners, including the commit guard.
const maintenanceAuthority = new AsyncLocalStorage<{
  assertCurrent: () => void;
  signal?: AbortSignal;
}>();

export function withMemoryMaintenanceAuthority<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  assertCurrent();
  return maintenanceAuthority.run({ assertCurrent, signal }, run);
}

export function captureMemoryMaintenanceAuthority(): (() => void) | undefined {
  const authority = maintenanceAuthority.getStore();
  return authority
    ? () => {
        authority.signal?.throwIfAborted();
        authority.assertCurrent();
      }
    : undefined;
}

export function assertMemoryMaintenanceAuthority(): void {
  const authority = maintenanceAuthority.getStore();
  authority?.signal?.throwIfAborted();
  authority?.assertCurrent();
}

export function withMemoryMaintenanceSignal(signal?: AbortSignal): AbortSignal | undefined {
  const maintenanceSignal = maintenanceAuthority.getStore()?.signal;
  return signal && maintenanceSignal
    ? AbortSignal.any([signal, maintenanceSignal])
    : (signal ?? maintenanceSignal);
}
