import { a as MigrationItem } from "../../types-CyE3PKKi.js";
import { t as ClaudeSource } from "../../source-BenyExW5.js";
import { t as PlannedTargets } from "../../targets-CTkVO4Ix.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };