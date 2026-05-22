import { a as MigrationItem } from "../../types-wNLvWYuA.js";
import { t as ClaudeSource } from "../../source-BQWw5hvv.js";
import { t as PlannedTargets } from "../../targets-BX7ezsp3.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };