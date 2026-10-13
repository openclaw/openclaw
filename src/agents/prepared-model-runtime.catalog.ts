import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.owner.js";
import { refreshPublishedModelRuntimeCatalog } from "./prepared-model-runtime.published-owner.js";
import type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

export function createPreparedModelRuntimeCatalogRefresh(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
) {
  return (
    snapshot: Parameters<typeof refreshPublishedModelRuntimeCatalog>[0],
    options: PreparedModelCatalogRefreshOptions = {},
  ) => refreshPublishedModelRuntimeCatalog(snapshot, owners, options);
}
