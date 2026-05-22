import { l as MigrationItem } from "../../types-CkHYPqDj.js";
import { t as ClaudeSource } from "../../source-Dl2sC9EB.js";
import { t as PlannedTargets } from "../../targets-D8PfetYS.js";

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