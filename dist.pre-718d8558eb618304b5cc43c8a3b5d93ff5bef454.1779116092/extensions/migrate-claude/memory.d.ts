import { a as MigrationItem } from "../../types-CWJThuOe2.js";
import { t as ClaudeSource } from "../../source-DYmtTGzZ.js";
import { t as PlannedTargets } from "../../targets-CMOdtqQG.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };