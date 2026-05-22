import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-D5GEzFhB.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };