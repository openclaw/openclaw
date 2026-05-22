import { l as MigrationItem } from "../../types-B1YsHkjI.js";
import { t as ClaudeSource } from "../../source-Btp1WclG.js";
import { t as PlannedTargets } from "../../targets-C0mHiBUN.js";

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