import { l as MigrationItem } from "../../types-_HTuWOFH.js";
import { t as HermesSource } from "../../source-Bw77r7JO.js";
import { t as PlannedTargets } from "../../targets-zWKwJ_ZM.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };