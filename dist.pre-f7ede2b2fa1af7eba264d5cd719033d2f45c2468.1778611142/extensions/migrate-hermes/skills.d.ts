import { a as MigrationItem } from "../../types-DKA4S1yN.js";
import { t as HermesSource } from "../../source--mzSiP64.js";
import { t as PlannedTargets } from "../../targets-CIpyvxlp.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };