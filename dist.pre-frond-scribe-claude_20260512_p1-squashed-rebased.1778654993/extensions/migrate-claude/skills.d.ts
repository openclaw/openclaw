import { a as MigrationItem } from "../../types-ItMBrbf4.js";
import { t as ClaudeSource } from "../../source-A7Yd66aa.js";
import { t as PlannedTargets } from "../../targets-BDb-__NV.js";

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