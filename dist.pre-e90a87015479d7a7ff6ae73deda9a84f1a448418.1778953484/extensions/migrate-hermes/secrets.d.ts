import { a as MigrationItem, u as MigrationProviderContext } from "../../types-CT4HF0Ri.js";
import { t as HermesSource } from "../../source-DHGMFhno.js";
import { t as PlannedTargets } from "../../targets-C_iaScTx.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };