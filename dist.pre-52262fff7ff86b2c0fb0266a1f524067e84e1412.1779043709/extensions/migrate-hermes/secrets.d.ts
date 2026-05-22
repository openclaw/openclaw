import { a as MigrationItem, u as MigrationProviderContext } from "../../types-BM0xoSYJ2.js";
import { t as HermesSource } from "../../source-BSSYucFZ.js";
import { t as PlannedTargets } from "../../targets-CqAQsU9G.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };