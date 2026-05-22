import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-UTp4ves_.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };