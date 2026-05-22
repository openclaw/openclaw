import { a as MigrationItem, u as MigrationProviderContext } from "../../types-DaukV8xd.js";
import { t as HermesSource } from "../../source-7e36EIbH.js";
import { t as PlannedTargets } from "../../targets-DClfgsE_.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };