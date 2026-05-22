import { l as MigrationItem } from "../../types-Wr1dwNsu.js";
import { t as HermesSource } from "../../source-Cz5afJ13.js";
import { t as PlannedTargets } from "../../targets-DEGJv5wZ.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };