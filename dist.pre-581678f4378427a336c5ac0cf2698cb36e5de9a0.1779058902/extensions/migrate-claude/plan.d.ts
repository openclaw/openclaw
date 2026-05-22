import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-Dd0yIOXW2.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };