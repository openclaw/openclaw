import { a as MigrationItem, u as MigrationProviderContext } from "../../types-ItMBrbf4.js";
import { t as HermesSource } from "../../source-g-nHHEN9.js";
import { t as PlannedTargets } from "../../targets-CljEqvRE.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };