import { l as MigrationItem } from "../../types-Wr1dwNsu.js";
import { t as ClaudeSource } from "../../source-CPi__moy.js";
import { t as PlannedTargets } from "../../targets-DaDfhDgL.js";

//#region extensions/migrate-claude/skills.d.ts
declare function buildSkillItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
declare function applyGeneratedSkillItem(item: MigrationItem, opts?: {
  overwrite?: boolean;
}): Promise<MigrationItem>;
//#endregion
export { applyGeneratedSkillItem, buildSkillItems };