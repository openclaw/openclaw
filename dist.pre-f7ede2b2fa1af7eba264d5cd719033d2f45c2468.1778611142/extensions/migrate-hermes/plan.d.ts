import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-DKA4S1yN.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };