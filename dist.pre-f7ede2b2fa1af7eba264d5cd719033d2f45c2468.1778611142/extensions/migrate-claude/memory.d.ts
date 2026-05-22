import { a as MigrationItem } from "../../types-DKA4S1yN.js";
import { t as ClaudeSource } from "../../source-Btp1WclG.js";
import { t as PlannedTargets } from "../../targets-BOgr4H0O.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };