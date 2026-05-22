import { a as MigrationItem } from "../../types-D1CySu2x.js";
import { t as ClaudeSource } from "../../source-C0us2g7U.js";
import { t as PlannedTargets } from "../../targets-BKSK1jJ2.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };