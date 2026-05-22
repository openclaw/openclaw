import { a as MigrationItem, u as MigrationProviderContext } from "../../types-Dggwf5Fv.js";
import { t as HermesSource } from "../../source-oQK9NDya.js";
import { t as PlannedTargets } from "../../targets-DWMRAKbO.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };