import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-1gFCH89g.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };