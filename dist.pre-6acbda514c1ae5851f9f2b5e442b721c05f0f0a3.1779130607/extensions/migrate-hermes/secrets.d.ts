import { l as MigrationItem, m as MigrationProviderContext } from "../../types-CkHYPqDj.js";
import { t as HermesSource } from "../../source-CqXhE9Du.js";
import { t as PlannedTargets } from "../../targets-CYE06RVa.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };