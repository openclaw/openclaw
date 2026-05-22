import { l as MigrationItem } from "../../types-D0OCNFd4.js";
import { t as HermesSource } from "../../source-CGk2OrW7.js";
import { t as PlannedTargets } from "../../targets-C_Yf-6Cz.js";

//#region extensions/migrate-hermes/skills.d.ts
declare function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]>;
//#endregion
export { buildSkillItems };