import { l as MigrationItem } from "../../types-B1YsHkjI.js";
import { t as HermesSource } from "../../source--mzSiP64.js";
import { t as PlannedTargets } from "../../targets-D4SVHU_Y.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };