import { l as MigrationItem } from "../../types-Bb8qdnX4.js";
import { t as ClaudeSource } from "../../source-Buy7y0YI.js";
import { t as PlannedTargets } from "../../targets-CR3NndAV.js";

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