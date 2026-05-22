import { l as MigrationItem } from "../../types-UTp4ves_.js";
import { t as ClaudeSource } from "../../source-CNUnvYXc.js";
import { t as PlannedTargets } from "../../targets-B2p9E_DI.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };