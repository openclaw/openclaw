// Retain owner cleanup when resources start so teardown needs no runtime import
// after an in-place update replaces the loaded build's chunks.
let managedProviderLocalServicesStop: (() => Promise<void>) | undefined;
let providerTransportDispatcherPoolActive = false;

export function setManagedProviderLocalServicesStop(stop: (() => Promise<void>) | undefined): void {
  managedProviderLocalServicesStop = stop;
}

export function hasManagedProviderLocalServices(): boolean {
  return managedProviderLocalServicesStop !== undefined;
}

export async function stopActiveManagedProviderLocalServices(): Promise<void> {
  await managedProviderLocalServicesStop?.();
}

export function setProviderTransportDispatcherPoolActive(active: boolean): void {
  providerTransportDispatcherPoolActive = active;
}

export function hasProviderTransportDispatcherPool(): boolean {
  return providerTransportDispatcherPoolActive;
}
