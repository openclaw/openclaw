import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-CQScvK0N.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };