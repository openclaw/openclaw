import { a as MigrationItem, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
import { t as HermesSource } from "../../source-CkGXp_tM.js";
import { t as PlannedTargets } from "../../targets-IR-Vo2KX.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };