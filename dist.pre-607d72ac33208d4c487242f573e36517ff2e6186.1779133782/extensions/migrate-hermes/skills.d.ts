import { l as MigrationItem } from "../../types-XJr-3iEG.js";
import { t as HermesSource } from "../../source-S0jTMO2G.js";
import { t as PlannedTargets } from "../../targets-E4lKxvlh.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };