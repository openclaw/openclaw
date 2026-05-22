import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-TY_PD3kg.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };