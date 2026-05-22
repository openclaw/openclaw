import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-C6a4QJNn.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };