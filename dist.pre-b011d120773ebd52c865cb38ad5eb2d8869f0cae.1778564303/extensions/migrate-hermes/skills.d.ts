import { a as MigrationItem } from "../../types-CyE3PKKi.js";
import { t as HermesSource } from "../../source-ChAkDgcf.js";
import { t as PlannedTargets } from "../../targets-DkODNswy.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };