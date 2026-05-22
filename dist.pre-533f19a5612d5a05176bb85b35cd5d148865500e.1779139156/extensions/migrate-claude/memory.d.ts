import { l as MigrationItem } from "../../types-Cdl1yOYR.js";
import { t as ClaudeSource } from "../../source-BBLVZvJ0.js";
import { t as PlannedTargets } from "../../targets-DA3phcCn.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };