import { a as MigrationItem } from "../../types-lCXG2pW_.js";
import { t as ClaudeSource } from "../../source-P3GL63PJ.js";
import { t as PlannedTargets } from "../../targets-DRKcxIRA.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };