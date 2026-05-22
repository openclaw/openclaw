import { a as MigrationItem } from "../../types-CT4HF0Ri.js";
import { t as HermesSource } from "../../source-DHGMFhno.js";
import { t as PlannedTargets } from "../../targets-C_iaScTx.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };