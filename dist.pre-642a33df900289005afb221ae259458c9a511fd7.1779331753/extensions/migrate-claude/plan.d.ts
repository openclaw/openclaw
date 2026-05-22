import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-DolEO2Jl.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };