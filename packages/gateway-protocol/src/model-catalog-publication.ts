import type { ConnectParams } from "./schema/frames.js";
import type { ModelsListParams, ModelsListResult } from "./schema/model-catalog.js";

export type ModelCatalogScope = Pick<ModelsListParams, "agentId" | "sessionKey">;
export type ModelCatalogTarget = NonNullable<ConnectParams["modelCatalog"]>;

/** Published configured projection for one authenticated connection's initial scope. */
export type ModelsSnapshotEvent = {
  target: ModelCatalogTarget;
  scope: ModelCatalogScope;
  catalog: ModelsListResult;
};
