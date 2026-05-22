import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-D5GEzFhB.js";
//#region extensions/whatsapp/src/state-migrations.d.ts
declare function detectWhatsAppLegacyStateMigrations(params: {
  oauthDir: string;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectWhatsAppLegacyStateMigrations };