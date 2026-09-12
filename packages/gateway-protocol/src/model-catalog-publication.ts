import type { ModelsListParams, ModelsListResult } from "./schema/agents-models-skills.js";
import type { ConnectParams } from "./schema/frames.js";

export type ModelCatalogScope = Pick<ModelsListParams, "agentId" | "sessionKey">;
export type ModelCatalogTarget = NonNullable<ConnectParams["modelCatalog"]>;

/** Published configured projection for one authenticated connection's initial scope. */
export type ModelsSnapshotEvent = {
  target: ModelCatalogTarget;
  scope: ModelCatalogScope;
  catalog: ModelsListResult;
};
