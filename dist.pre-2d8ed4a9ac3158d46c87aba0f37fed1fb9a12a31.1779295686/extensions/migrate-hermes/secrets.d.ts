import { l as MigrationItem, m as MigrationProviderContext } from "../../types-D0OCNFd4.js";
import { t as HermesSource } from "../../source-CGk2OrW7.js";
import { t as PlannedTargets } from "../../targets-C_Yf-6Cz.js";

//#region extensions/migrate-hermes/secrets.d.ts
declare function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]>;
declare function applySecretItem(ctx: MigrationProviderContext, item: MigrationItem, targets: PlannedTargets): Promise<MigrationItem>;
//#endregion
export { applySecretItem, buildSecretItems };