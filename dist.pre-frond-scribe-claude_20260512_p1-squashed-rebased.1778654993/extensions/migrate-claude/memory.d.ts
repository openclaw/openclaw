import { a as MigrationItem } from "../../types-ItMBrbf4.js";
import { t as ClaudeSource } from "../../source-A7Yd66aa.js";
import { t as PlannedTargets } from "../../targets-BDb-__NV.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };