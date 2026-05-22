import { n as isLegacyGroupSessionKey, t as canonicalizeLegacySessionKey } from "../../session-contract-D3LSV2E3.js";

//#region extensions/whatsapp/legacy-session-surface-api.d.ts
declare const whatsappLegacySessionSurface: {
  isLegacyGroupSessionKey: typeof isLegacyGroupSessionKey;
  canonicalizeLegacySessionKey: typeof canonicalizeLegacySessionKey;
};
//#endregion
export { whatsappLegacySessionSurface };