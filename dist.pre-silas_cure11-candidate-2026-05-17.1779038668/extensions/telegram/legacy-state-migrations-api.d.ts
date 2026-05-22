import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-CcKckzwX.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };