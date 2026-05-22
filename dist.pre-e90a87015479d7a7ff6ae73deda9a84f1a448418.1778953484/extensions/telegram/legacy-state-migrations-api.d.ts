import { i as OpenClawConfig } from "../../types.openclaw-DNoZmPZ8.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-yC1NCFUF.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };