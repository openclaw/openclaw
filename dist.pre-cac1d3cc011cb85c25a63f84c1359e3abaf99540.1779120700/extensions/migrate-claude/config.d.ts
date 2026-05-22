import { l as MigrationItem, m as MigrationProviderContext } from "../../types-UTp4ves_.js";
import { t as ClaudeSource } from "../../source-CNUnvYXc.js";

//#region extensions/migrate-claude/config.d.ts
declare function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  source: ClaudeSource;
}): Promise<MigrationItem[]>;
declare function applyConfigItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
declare function applyManualItem(item: MigrationItem): MigrationItem;
//#endregion
export { applyConfigItem, applyManualItem, buildConfigItems };