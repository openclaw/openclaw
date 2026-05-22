import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-Cdl1yOYR.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };