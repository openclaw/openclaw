import { a as MigrationItem } from "../../types-lCXG2pW_.js";
import { t as ClaudeSource } from "../../source-P3GL63PJ.js";
import { t as PlannedTargets } from "../../targets-DRKcxIRA.js";

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