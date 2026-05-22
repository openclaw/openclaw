import { a as MigrationItem } from "../../types-DaukV8xd.js";
import { t as ClaudeSource } from "../../source-CNUnvYXc.js";
import { t as PlannedTargets } from "../../targets-Du8m6AnD.js";

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