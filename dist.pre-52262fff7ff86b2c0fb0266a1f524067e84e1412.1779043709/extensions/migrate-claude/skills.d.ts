import { a as MigrationItem } from "../../types-BM0xoSYJ2.js";
import { t as ClaudeSource } from "../../source-DMHoakKc.js";
import { t as PlannedTargets } from "../../targets-Cuxkb1sT.js";

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