import { a as MigrationItem, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
import { t as ClaudeSource } from "../../source-P3GL63PJ.js";

//#region extensions/migrate-claude/config.d.ts
declare function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  source: ClaudeSource;
}): Promise<MigrationItem[]>;
declare function applyConfigItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
declare function applyManualItem(item: MigrationItem): MigrationItem;
//#endregion
export { applyConfigItem, applyManualItem, buildConfigItems };