import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-1gJzFdXJ.js";
//#region extensions/telegram/src/state-migrations.d.ts
declare function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectTelegramLegacyStateMigrations };