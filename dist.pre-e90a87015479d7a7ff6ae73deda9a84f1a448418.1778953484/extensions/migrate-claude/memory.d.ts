import { a as MigrationItem } from "../../types-CT4HF0Ri.js";
import { t as ClaudeSource } from "../../source-D1f4I985.js";
import { t as PlannedTargets } from "../../targets-X1Biui1G.js";

//#region extensions/migrate-claude/memory.d.ts
declare function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildMemoryItems };