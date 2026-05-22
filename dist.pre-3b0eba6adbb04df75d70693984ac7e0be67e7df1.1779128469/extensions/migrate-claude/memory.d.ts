import { l as MigrationItem } from "../../types-_HTuWOFH.js";
import { t as ClaudeSource } from "../../source-BQOdHMoa.js";
import { t as PlannedTargets } from "../../targets-wGGfqpeo.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };