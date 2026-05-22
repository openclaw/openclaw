import { a as MigrationItem } from "../../types-9OpM7mYQ.js";
import { t as HermesSource } from "../../source-oQK9NDya.js";
import { t as PlannedTargets } from "../../targets-6n7XNfUV.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };