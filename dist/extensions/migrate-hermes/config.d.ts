import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-hermes/config.d.ts
declare function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  config: Record<string, unknown>;
  modelRef?: string;
  hasMemoryFiles?: boolean;
}): MigrationItem[];
declare function applyConfigItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
declare function applyManualItem(item: MigrationItem): MigrationItem;
//#endregion
export { applyConfigItem, applyManualItem, buildConfigItems };