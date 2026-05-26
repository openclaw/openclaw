import { d as MigrationProviderPlugin, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
//#region extensions/migrate-hermes/provider.d.ts
declare function buildHermesMigrationProvider(params?: {
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderPlugin;
//#endregion
export { buildHermesMigrationProvider };