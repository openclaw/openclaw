export type BundledChannelOutboundAdapter = {
  id: string;
  version: string;
  supports: string[];
};

export type BundledChannelOutboundAdapterRegistry = Map<string, BundledChannelOutboundAdapter>;

export function createBundledChannelAdapterRegistry(): BundledChannelOutboundAdapterRegistry {
  return new Map();
}

export function registerBundledChannelAdapter(
  registry: BundledChannelOutboundAdapterRegistry,
  adapter: BundledChannelOutboundAdapter,
): void {
  registry.set(adapter.id, adapter);
}

export function getBundledChannelAdapter(
  registry: BundledChannelOutboundAdapterRegistry,
  adapterId: string,
): BundledChannelOutboundAdapter | undefined {
  return registry.get(adapterId);
}

export function listBundledChannelAdapters(
  registry: BundledChannelOutboundAdapterRegistry,
): BundledChannelOutboundAdapter[] {
  return Array.from(registry.values());
}
