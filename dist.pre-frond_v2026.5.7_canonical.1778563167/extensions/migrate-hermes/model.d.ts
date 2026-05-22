import { a as MigrationItem, u as MigrationProviderContext } from "../../types-D40p5jC7.js";
//#region extensions/migrate-hermes/model.d.ts
declare function resolveHermesModelRef(config: Record<string, unknown>): string | undefined;
declare function resolveCurrentModelRef(ctx: MigrationProviderContext): string | undefined;
declare function applyModelItem(ctx: MigrationProviderContext, item: MigrationItem): Promise<MigrationItem>;
//#endregion
export { applyModelItem, resolveCurrentModelRef, resolveHermesModelRef };