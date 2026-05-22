import { a as MigrationItem } from "../../types-9OpM7mYQ.js";
import { t as ClaudeSource } from "../../source-kx-bQWP4.js";
import { t as PlannedTargets } from "../../targets-CYnFiQLf.js";

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