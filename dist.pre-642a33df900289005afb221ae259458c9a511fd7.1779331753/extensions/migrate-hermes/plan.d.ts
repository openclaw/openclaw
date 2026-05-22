import { m as MigrationProviderContext, p as MigrationPlan } from "../../types-DolEO2Jl.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };