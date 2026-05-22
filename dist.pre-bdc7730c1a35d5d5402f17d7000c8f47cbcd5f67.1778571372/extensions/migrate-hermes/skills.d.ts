import { a as MigrationItem } from "../../types-D1CySu2x.js";
import { t as HermesSource } from "../../source-CnKo2CP0.js";
import { t as PlannedTargets } from "../../targets-DxLQYWo5.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };