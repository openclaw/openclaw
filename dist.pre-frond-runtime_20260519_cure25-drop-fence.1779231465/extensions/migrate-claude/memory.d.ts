import { l as MigrationItem } from "../../types-B1YsHkjI.js";
import { t as ClaudeSource } from "../../source-Btp1WclG.js";
import { t as PlannedTargets } from "../../targets-C0mHiBUN.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };