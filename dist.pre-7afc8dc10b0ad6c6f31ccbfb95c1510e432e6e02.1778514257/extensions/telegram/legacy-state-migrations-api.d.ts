import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-gexONR-2.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };