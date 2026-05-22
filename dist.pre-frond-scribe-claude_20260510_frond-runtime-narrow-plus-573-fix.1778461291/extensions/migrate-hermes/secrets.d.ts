import { a as MigrationItem, u as MigrationProviderContext } from "../../types-BYigPDoy.js";
import { t as HermesSource } from "../../source-C9xvritW.js";
import { t as PlannedTargets } from "../../targets-CDj1gut2.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };