import { i as OpenClawConfig } from "../../types.openclaw-C5VNg6h3.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-BHltg72J.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };