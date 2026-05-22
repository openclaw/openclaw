import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-zIW2Gjsy.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };