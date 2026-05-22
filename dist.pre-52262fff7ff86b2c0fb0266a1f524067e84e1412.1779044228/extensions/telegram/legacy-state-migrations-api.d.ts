import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-CgjRAtD6.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };