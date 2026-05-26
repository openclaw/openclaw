import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-BkmTlRzr.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };