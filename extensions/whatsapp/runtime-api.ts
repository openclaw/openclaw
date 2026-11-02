export {
  getActiveWebListener,
  resolveWebAccountId,
  type ActiveWebListener,
  type ActiveWebSendOptions,
} from "./src/active-listener.js";
export { handleWhatsAppAction, whatsAppActionRuntime } from "./src/action-runtime.js";
export { createWhatsAppLoginTool } from "./src/agent-tools-login.js";
export {
  formatWhatsAppWebAuthStatusState,
  getWebAuthAgeMs,
  hasWebCredsSync,
  logWebSelfId,
  logoutWeb,
  pickWebChannel,
  readCredsJsonRaw,
  readWebAuthExistsBestEffort,
  readWebAuthExistsForDecision,
  readWebAuthSnapshot,
  readWebAuthSnapshotBestEffort,
  readWebAuthState,
  readWebSelfId,
  readWebSelfIdentity,
  readWebSelfIdentityForDecision,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
  restoreCredsFromBackupIfNeeded,
  webAuthExists,
  WA_WEB_AUTH_DIR,
  WHATSAPP_AUTH_UNSTABLE_CODE,
  WhatsAppAuthUnstableError,
  type WhatsAppWebAuthState,
} from "./src/auth-store.js";
export { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";

export { DEFAULT_WEB_MEDIA_BYTES } from "./src/auto-reply/constants.js";
export { monitorWebChannel } from "./src/auto-reply/monitor.js";
export type { WebChannelStatus, WebMonitorTuning } from "./src/auto-reply/types.js";
export { resetWebInboundDedupe } from "./src/inbound/dedupe.js";
export { extractContactContext, extractLocationData, extractText } from "./src/inbound/extract.js";
export { monitorWebInbox } from "./src/inbound/monitor.js";
export type { WhatsAppInboundAdmission } from "./src/inbound/admission.js";
export type {
  WebInboundCallbackMessage,
  WebInboundMessage,
  WebListenerCloseReason,
} from "./src/inbound/types.js";
export { loginWeb } from "./src/login.js";
export {
  getDefaultLocalRoots,
  loadWebMedia,
  loadWebMediaRaw,
  LocalMediaAccessError,
  optimizeImageToJpeg,
  optimizeImageToPng,
  type LocalMediaAccessErrorCode,
  type WebMediaResult,
} from "openclaw/plugin-sdk/web-media";
export {
  sendMessageWhatsApp,
  sendPollWhatsApp,
  sendReactionWhatsApp,
  sendTypingWhatsApp,
} from "./src/send.js";
export {
  createWaSocket,
  formatError,
  getStatusCode,
  newConnectionId,
  waitForCredsSaveQueue,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
  writeCredsJsonAtomically,
  type CredsQueueWaitResult,
} from "./src/session.js";
export { setWhatsAppRuntime } from "./src/runtime.js";
export { startWebLoginWithQr, waitForWebLogin } from "./login-qr-runtime.js";
