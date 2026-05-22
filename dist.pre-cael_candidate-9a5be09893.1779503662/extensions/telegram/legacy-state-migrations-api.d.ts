import { i as OpenClawConfig } from "../../types.openclaw-BorXMoYB.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-Dsbrk0cK.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };