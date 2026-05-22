import { l as MigrationItem } from "../../types-CkHYPqDj.js";
import { t as HermesSource } from "../../source-CqXhE9Du.js";
import { t as PlannedTargets } from "../../targets-CYE06RVa.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };