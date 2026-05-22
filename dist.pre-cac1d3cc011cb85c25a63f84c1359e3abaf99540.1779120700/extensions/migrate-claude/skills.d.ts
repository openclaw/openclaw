import { l as MigrationItem } from "../../types-UTp4ves_.js";
import { t as ClaudeSource } from "../../source-CNUnvYXc.js";
import { t as PlannedTargets } from "../../targets-B2p9E_DI.js";

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