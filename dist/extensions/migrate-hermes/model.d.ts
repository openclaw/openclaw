import { l as MigrationItem, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-hermes/model.d.ts
declare function resolveHermesModelRef(config: Record<string, unknown>): string | undefined;
declare function resolveCurrentModelRef(ctx: MigrationProviderContext): string | undefined;
declare function applyModelItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
//#endregion
export { applyModelItem, resolveCurrentModelRef, resolveHermesModelRef };