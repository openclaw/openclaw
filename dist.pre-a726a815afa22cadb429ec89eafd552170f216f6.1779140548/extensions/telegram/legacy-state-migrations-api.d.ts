import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-DrB_kWzl.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };