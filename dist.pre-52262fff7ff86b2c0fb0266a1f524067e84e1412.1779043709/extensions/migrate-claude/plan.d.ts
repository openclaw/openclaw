import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-BM0xoSYJ2.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };