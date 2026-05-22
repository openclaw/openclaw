import { l as MigrationItem } from "../../types-CRFXnxy2.js";
import { t as HermesSource } from "../../source-P1gBkxLQ.js";
import { t as PlannedTargets } from "../../targets-CFSweWCs.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };