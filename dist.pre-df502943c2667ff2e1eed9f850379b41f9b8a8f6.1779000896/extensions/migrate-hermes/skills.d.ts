import { a as MigrationItem } from "../../types-DdGVOQ6y.js";
import { t as HermesSource } from "../../source-Dh2ZJ29d.js";
import { t as PlannedTargets } from "../../targets-CMtY6AD1.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };