import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-CyE3PKKi.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };