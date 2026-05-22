import { a as MigrationItem } from "../../types-BYigPDoy.js";
import { t as ClaudeSource } from "../../source-BEuQuHqS.js";
import { t as PlannedTargets } from "../../targets-DiAZkS20.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };