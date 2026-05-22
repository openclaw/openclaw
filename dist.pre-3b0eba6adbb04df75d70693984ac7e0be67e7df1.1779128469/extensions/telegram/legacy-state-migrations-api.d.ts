import { i as OpenClawConfig } from "../../types.openclaw-DZQrhn8E.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-DiLRQ15F.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };