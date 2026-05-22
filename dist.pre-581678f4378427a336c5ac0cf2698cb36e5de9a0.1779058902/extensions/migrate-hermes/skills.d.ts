import { a as MigrationItem } from "../../types-Dd0yIOXW2.js";
import { t as HermesSource } from "../../source-DlxnbSXp.js";
import { t as PlannedTargets } from "../../targets-B4WCw-79.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };