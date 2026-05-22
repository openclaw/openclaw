import { l as MigrationItem } from "../../types-CkHYPqDj.js";
import { t as ClaudeSource } from "../../source-Dl2sC9EB.js";
import { t as PlannedTargets } from "../../targets-D8PfetYS.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };