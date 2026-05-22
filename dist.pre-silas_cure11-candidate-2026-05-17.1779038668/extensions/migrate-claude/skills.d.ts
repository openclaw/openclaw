import { a as MigrationItem } from "../../types-wNLvWYuA.js";
import { t as ClaudeSource } from "../../source-BQWw5hvv.js";
import { t as PlannedTargets } from "../../targets-BX7ezsp3.js";

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