import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-DMG-czl3.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };