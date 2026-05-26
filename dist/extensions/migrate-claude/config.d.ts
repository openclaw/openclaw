import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
import { t as ClaudeSource } from "../../source-Czne5iNW.js";

//#region extensions/migrate-claude/config.d.ts
declare function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  source: ClaudeSource;
}): Promise<MigrationItem[]>;
declare function applyConfigItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
declare function applyManualItem(item: MigrationItem): MigrationItem;
//#endregion
export { applyConfigItem, applyManualItem, buildConfigItems };