import { u as MigrationProviderContext } from "./types-DdGVOQ6y.js";
//#region extensions/migrate-hermes/targets.d.ts
type PlannedTargets = {
  workspaceDir: string;
  stateDir: string;
  agentDir: string;
};
declare function resolveTargets(ctx: MigrationProviderContext): PlannedTargets;
//#endregion
export { resolveTargets as n, PlannedTargets as t };