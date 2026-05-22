import { a as MigrationItem } from "../../types-DdGVOQ6y.js";
import { t as ClaudeSource } from "../../source-BQWw5hvv.js";
import { t as PlannedTargets } from "../../targets-CWCCyjKJ.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };