import { l as MigrationPlan, u as MigrationProviderContext } from "../../types-BM0xoSYJ2.js";
//#region extensions/migrate-hermes/plan.d.ts
declare function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan>;
//#endregion
export { buildHermesPlan };