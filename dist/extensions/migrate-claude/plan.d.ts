import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-Vx7Jq4_-2.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };