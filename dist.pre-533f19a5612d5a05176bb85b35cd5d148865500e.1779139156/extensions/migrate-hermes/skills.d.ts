import { l as MigrationItem } from "../../types-Cdl1yOYR.js";
import { t as HermesSource } from "../../source-1KtIXX9a.js";
import { t as PlannedTargets } from "../../targets-gEBETvga.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };