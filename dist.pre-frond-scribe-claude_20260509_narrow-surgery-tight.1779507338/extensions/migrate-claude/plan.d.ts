import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-CRFXnxy2.js";
//#region extensions/migrate-claude/plan.d.ts
declare function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildClaudePlan };