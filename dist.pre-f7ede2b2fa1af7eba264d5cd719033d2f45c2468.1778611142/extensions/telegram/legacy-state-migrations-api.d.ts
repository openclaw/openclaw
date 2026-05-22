import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-BoZgMdCh.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };