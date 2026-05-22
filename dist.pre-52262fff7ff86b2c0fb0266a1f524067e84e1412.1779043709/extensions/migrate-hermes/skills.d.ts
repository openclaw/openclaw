import { a as MigrationItem } from "../../types-BM0xoSYJ2.js";
import { t as HermesSource } from "../../source-BSSYucFZ.js";
import { t as PlannedTargets } from "../../targets-CqAQsU9G.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };