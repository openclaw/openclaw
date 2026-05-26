import { a as MigrationItem, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
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