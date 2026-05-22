import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-CRFXnxy2.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };