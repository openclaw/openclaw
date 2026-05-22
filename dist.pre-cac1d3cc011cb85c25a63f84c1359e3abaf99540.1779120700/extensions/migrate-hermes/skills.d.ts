import { l as MigrationItem } from "../../types-UTp4ves_.js";
import { t as HermesSource } from "../../source-7e36EIbH.js";
import { t as PlannedTargets } from "../../targets-CjM7WkkJ.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };