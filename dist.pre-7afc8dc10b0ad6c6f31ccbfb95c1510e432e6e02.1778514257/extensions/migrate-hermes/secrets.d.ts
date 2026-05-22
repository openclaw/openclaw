import { a as MigrationItem, u as MigrationProviderContext } from "../../types-BOTb5nyG.js";
import { t as HermesSource } from "../../source-Bw77r7JO.js";
import { t as PlannedTargets } from "../../targets-cXHOZjGq.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };