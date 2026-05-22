import { l as MigrationItem } from "../../types-CPAF_tyr.js";
import { t as HermesSource } from "../../source-Cz5afJ13.js";
import { t as PlannedTargets } from "../../targets-C3ljYhQl.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };