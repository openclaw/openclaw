import { a as MigrationItem } from "../../types-CWJThuOe2.js";
import { t as HermesSource } from "../../source-D0CwMhsX.js";
import { t as PlannedTargets } from "../../targets-DSbpeSIU.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };