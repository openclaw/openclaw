import { l as MigrationItem, m as MigrationProviderContext } from "../../types-UTp4ves_.js";
import { t as HermesSource } from "../../source-7e36EIbH.js";
import { t as PlannedTargets } from "../../targets-CjM7WkkJ.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };