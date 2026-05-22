import { n as isLegacyGroupSessionKey, t as canonicalizeLegacySessionKey } from "../../session-contract--VK_94RM.js";

//#region extensions/whatsapp/legacy-session-surface-api.d.ts
declare const whatsappLegacySessionSurface: {
  isLegacyGroupSessionKey: typeof isLegacyGroupSessionKey;
  canonicalizeLegacySessionKey: typeof canonicalizeLegacySessionKey;
};
//#endregion
export { whatsappLegacySessionSurface };