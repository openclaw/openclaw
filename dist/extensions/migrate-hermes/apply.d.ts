import { m as MigrationProviderContext, p as MigrationPlan, s as MigrationApplyResult } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-hermes/apply.d.ts
declare function applyHermesPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult>;
//#endregion
export { applyHermesPlan };