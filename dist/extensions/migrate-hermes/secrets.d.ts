import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
import { t as HermesSource } from "../../source-P1gBkxLQ.js";
import { t as PlannedTargets } from "../../targets-Ct_wrBGX.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };