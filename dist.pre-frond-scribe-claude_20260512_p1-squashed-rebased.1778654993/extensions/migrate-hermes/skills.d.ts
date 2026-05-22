import { a as MigrationItem } from "../../types-ItMBrbf4.js";
import { t as HermesSource } from "../../source-g-nHHEN9.js";
import { t as PlannedTargets } from "../../targets-CljEqvRE.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };