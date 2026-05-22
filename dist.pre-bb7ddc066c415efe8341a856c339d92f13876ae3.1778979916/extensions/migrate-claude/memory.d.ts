import { a as MigrationItem } from "../../types-9OpM7mYQ.js";
import { t as ClaudeSource } from "../../source-kx-bQWP4.js";
import { t as PlannedTargets } from "../../targets-CYnFiQLf.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };