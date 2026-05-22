import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Cdl1yOYR.js";
import { t as HermesSource } from "../../source-1KtIXX9a.js";
import { t as PlannedTargets } from "../../targets-gEBETvga.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };