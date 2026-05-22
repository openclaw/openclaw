import { m as MigrationProviderContext } from "./types-CRFXnxy2.js";
//#region extensions/migrate-claude/targets.d.ts
type PlannedTargets = {
  workspaceDir: string;
  stateDir: string;
  agentDir: string;
};
declare function resolveTargets(ctx: MigrationProviderContext): PlannedTargets;
//#endregion
export { resolveTargets as n, PlannedTargets as t };