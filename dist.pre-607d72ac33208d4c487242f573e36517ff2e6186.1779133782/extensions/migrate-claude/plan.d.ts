import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-XJr-3iEG.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };