import { a as MigrationItem } from "../../types-BOTb5nyG.js";
import { t as HermesSource } from "../../source-Bw77r7JO.js";
import { t as PlannedTargets } from "../../targets-cXHOZjGq.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };