import { a as MigrationItem } from "../../types-DzWIJtb62.js";
import { t as ClaudeSource } from "../../source-2HmKu96L.js";
import { t as PlannedTargets } from "../../targets-CEHcc5jk.js";

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