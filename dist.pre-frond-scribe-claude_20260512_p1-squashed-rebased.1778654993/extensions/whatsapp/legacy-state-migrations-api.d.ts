import { g as ChannelLegacyStateMigrationPlan } from "../../types.core-BDQOD1ST.js";
//#region extensions/whatsapp/src/state-migrations.d.ts
declare function detectWhatsAppLegacyStateMigrations(params: {
  oauthDir: string;
}): ChannelLegacyStateMigrationPlan[];
//#endregion
export { detectWhatsAppLegacyStateMigrations };