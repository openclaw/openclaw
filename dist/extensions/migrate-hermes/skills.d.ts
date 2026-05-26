import { a as MigrationItem } from "../../types-lCXG2pW_.js";
import { t as HermesSource } from "../../source-CkGXp_tM.js";
import { t as PlannedTargets } from "../../targets-IR-Vo2KX.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };