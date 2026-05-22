import { l as MigrationItem } from "../../types-XJr-3iEG.js";
import { t as ClaudeSource } from "../../source-BEsciod9.js";
import { t as PlannedTargets } from "../../targets-DeHoFsNQ.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };