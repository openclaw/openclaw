import { a as MigrationItem } from "../../types-Dggwf5Fv.js";
import { t as ClaudeSource } from "../../source-DLbNFRWa.js";
import { t as PlannedTargets } from "../../targets-DdR1CoiN.js";

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