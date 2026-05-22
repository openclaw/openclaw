import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
//#region extensions/whatsapp/auth-presence.d.ts
type WhatsAppAuthPresenceParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
} | OpenClawConfig;
declare function hasAnyWhatsAppAuth(params: WhatsAppAuthPresenceParams, env?: NodeJS.ProcessEnv): boolean;
//#endregion
export { hasAnyWhatsAppAuth };