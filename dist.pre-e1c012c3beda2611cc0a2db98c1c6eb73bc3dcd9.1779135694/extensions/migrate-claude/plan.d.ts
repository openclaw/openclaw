import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-Wr1dwNsu.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };