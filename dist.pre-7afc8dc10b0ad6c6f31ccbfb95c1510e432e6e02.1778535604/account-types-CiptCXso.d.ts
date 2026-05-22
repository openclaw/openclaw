import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
//#region extensions/whatsapp/src/account-types.d.ts
type WhatsAppAccountConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["accounts"]>[string];
//#endregion
export { WhatsAppAccountConfig as t };