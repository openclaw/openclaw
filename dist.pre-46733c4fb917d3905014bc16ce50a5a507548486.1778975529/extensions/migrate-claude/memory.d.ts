import { a as MigrationItem } from "../../types-Dggwf5Fv.js";
import { t as ClaudeSource } from "../../source-DLbNFRWa.js";
import { t as PlannedTargets } from "../../targets-DdR1CoiN.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };