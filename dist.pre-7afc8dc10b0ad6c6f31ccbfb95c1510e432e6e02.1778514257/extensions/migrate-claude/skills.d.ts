import { a as MigrationItem } from "../../types-BOTb5nyG.js";
import { t as ClaudeSource } from "../../source-BQOdHMoa.js";
import { t as PlannedTargets } from "../../targets-CVWC5XBO.js";

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