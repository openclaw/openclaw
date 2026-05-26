import { l as MigrationPlan, r as MigrationApplyResult, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
//#region extensions/migrate-hermes/apply.d.ts
declare function applyHermesPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult>;
//#endregion
export { applyHermesPlan };