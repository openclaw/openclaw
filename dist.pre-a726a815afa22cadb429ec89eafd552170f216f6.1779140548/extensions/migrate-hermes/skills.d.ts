import { l as MigrationItem } from "../../types-Bb8qdnX4.js";
import { t as HermesSource } from "../../source-kSf0-h5S.js";
import { t as PlannedTargets } from "../../targets-DWLykMQn.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };