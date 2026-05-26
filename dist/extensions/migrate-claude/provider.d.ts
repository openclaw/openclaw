import { h as MigrationProviderPlugin, m as MigrationProviderContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-claude/provider.d.ts
declare function buildClaudeMigrationProvider(params?: {
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderPlugin;
//#endregion
export { buildClaudeMigrationProvider };