import { a as MigrationItem } from "../../types-D40p5jC7.js";
import { t as ClaudeSource } from "../../source-BenyExW5.js";
import { t as PlannedTargets } from "../../targets-lbAVMcvr.js";

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