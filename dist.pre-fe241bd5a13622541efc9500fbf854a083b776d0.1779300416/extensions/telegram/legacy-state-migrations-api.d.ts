import { i as OpenClawConfig } from "../../types.openclaw-Cy0U3Gwh.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-DzzzLcdL.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };