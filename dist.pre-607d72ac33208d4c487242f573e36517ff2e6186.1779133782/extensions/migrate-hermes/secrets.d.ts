import { l as MigrationItem, m as MigrationProviderContext } from "../../types-XJr-3iEG.js";
import { t as HermesSource } from "../../source-S0jTMO2G.js";
import { t as PlannedTargets } from "../../targets-E4lKxvlh.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };