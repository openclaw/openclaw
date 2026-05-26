import { h as MigrationProviderPlugin, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-hermes/provider.d.ts
declare function buildHermesMigrationProvider(params?: {
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderPlugin;
//#endregion
export { buildHermesMigrationProvider };