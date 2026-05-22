import { a as MigrationItem } from "../../types-DaukV8xd.js";
import { t as ClaudeSource } from "../../source-CNUnvYXc.js";
import { t as PlannedTargets } from "../../targets-Du8m6AnD.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };