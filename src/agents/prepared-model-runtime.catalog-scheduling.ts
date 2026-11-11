import pLimit from "p-limit";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

// Native discovery is shared across owners without blocking independent provider renewal.
const limitNativeCatalogDiscovery = pLimit(1);

export async function scheduleNativeCatalogDiscovery(
  previous: Promise<ModelCatalogSnapshot> | undefined,
  readReadyCatalog: () => ModelCatalogSnapshot | undefined,
  discover: () => Promise<ModelCatalogSnapshot>,
): Promise<ModelCatalogSnapshot> {
  // Join this owner's predecessor before taking shared capacity.
  await previous?.catch(() => undefined);
  const ready = readReadyCatalog();
  if (ready) {
    return ready;
  }
  return await limitNativeCatalogDiscovery(() => {
    // Readiness also checks current publication or retained lease authority after queuing.
    return readReadyCatalog() ?? discover();
  });
}
