import { l as MigrationItem, m as MigrationProviderContext } from "../../types-_HTuWOFH.js";
import { t as HermesSource } from "../../source-Bw77r7JO.js";
import { t as PlannedTargets } from "../../targets-zWKwJ_ZM.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };