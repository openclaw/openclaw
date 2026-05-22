import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Bb8qdnX4.js";
import { t as HermesSource } from "../../source-kSf0-h5S.js";
import { t as PlannedTargets } from "../../targets-DWLykMQn.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };