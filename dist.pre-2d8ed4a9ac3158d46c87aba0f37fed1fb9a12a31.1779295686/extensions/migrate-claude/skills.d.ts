import { l as MigrationItem } from "../../types-D0OCNFd4.js";
import { t as ClaudeSource } from "../../source-Ddtj8Xxu.js";
import { t as PlannedTargets } from "../../targets-BgkysMpQ.js";

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