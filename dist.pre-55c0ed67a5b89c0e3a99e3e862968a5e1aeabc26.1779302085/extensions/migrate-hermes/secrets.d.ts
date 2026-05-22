import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Dw7_sm4q.js";
import { t as HermesSource } from "../../source-P1gBkxLQ.js";
import { t as PlannedTargets } from "../../targets-BcSh0GuN.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };