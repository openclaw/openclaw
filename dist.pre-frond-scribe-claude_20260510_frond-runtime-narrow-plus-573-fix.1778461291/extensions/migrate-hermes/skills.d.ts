import { a as MigrationItem } from "../../types-BYigPDoy.js";
import { t as HermesSource } from "../../source-C9xvritW.js";
import { t as PlannedTargets } from "../../targets-CDj1gut2.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };