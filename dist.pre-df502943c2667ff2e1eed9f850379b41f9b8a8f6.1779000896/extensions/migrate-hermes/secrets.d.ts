import { a as MigrationItem, u as MigrationProviderContext } from "../../types-DdGVOQ6y.js";
import { t as HermesSource } from "../../source-Dh2ZJ29d.js";
import { t as PlannedTargets } from "../../targets-CMtY6AD1.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };