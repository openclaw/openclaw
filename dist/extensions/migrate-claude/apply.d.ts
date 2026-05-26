import { l as MigrationPlan, r as MigrationApplyResult, u as MigrationProviderContext } from "../../types-lCXG2pW_.js";
//#region extensions/migrate-claude/apply.d.ts
declare function applyClaudePlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult>;
//#endregion
export { applyClaudePlan };