import { a as MigrationItem } from "../../types-wNLvWYuA.js";
import { t as HermesSource } from "../../source-Dh2ZJ29d.js";
import { t as PlannedTargets } from "../../targets-DYMTx0Xr.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };