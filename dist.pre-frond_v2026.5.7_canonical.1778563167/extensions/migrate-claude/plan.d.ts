import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-D40p5jC7.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };