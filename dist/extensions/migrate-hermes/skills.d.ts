import { l as MigrationItem } from "../../types-Vx7Jq4_-2.js";
import { t as HermesSource } from "../../source-P1gBkxLQ.js";
import { t as PlannedTargets } from "../../targets-Ct_wrBGX.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };