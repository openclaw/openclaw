import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-DdGVOQ6y.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };