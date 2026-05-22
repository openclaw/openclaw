import { a as MigrationItem } from "../../types-BM0xoSYJ2.js";
import { t as ClaudeSource } from "../../source-DMHoakKc.js";
import { t as PlannedTargets } from "../../targets-Cuxkb1sT.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };