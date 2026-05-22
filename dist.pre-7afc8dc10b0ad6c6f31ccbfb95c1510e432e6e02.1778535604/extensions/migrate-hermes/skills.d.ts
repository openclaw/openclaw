import { a as MigrationItem } from "../../types-DaukV8xd.js";
import { t as HermesSource } from "../../source-7e36EIbH.js";
import { t as PlannedTargets } from "../../targets-DClfgsE_.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };