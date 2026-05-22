import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-remGx4m5.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };