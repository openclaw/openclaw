import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  type PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.owner.js";
import { refreshPublishedModelRuntimeCatalog } from "./prepared-model-runtime.published-owner.js";
import type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

export function advancePreparedModelRuntimeOwnersConfig(
  owners: Iterable<PreparedModelRuntimeOwner>,
  config: OpenClawConfig,
): void {
  for (const owner of owners) {
    // Read-only owners include the config hash in their map key and remain bound to their lease.
    if (!owner.input.readOnly) {
      advancePreparedModelRuntimeOwnerConfig(owner, config);
    }
  }
}

export function createPreparedModelRuntimeCatalogRefresh(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
) {
  return (
    snapshot: Parameters<typeof refreshPublishedModelRuntimeCatalog>[0],
    options: PreparedModelCatalogRefreshOptions = {},
  ) => refreshPublishedModelRuntimeCatalog(snapshot, owners, options);
}
