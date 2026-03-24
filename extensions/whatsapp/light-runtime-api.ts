// Light runtime exports for WhatsApp — loaded lazily by runtime-whatsapp-boundary.ts.
// This module contains only lightweight, non-socket-requiring exports.
export { getActiveWebListener } from "./src/active-listener.js";
export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./src/auth-store.js";
export { createWhatsAppLoginTool } from "./src/agent-tools-login.js";
export { formatError, getStatusCode } from "./src/session.js";
