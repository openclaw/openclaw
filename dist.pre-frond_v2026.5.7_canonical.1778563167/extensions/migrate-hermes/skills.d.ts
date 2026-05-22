import { a as MigrationItem } from "../../types-D40p5jC7.js";
import { t as HermesSource } from "../../source-ChAkDgcf.js";
import { t as PlannedTargets } from "../../targets-C4GnNNhQ.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };