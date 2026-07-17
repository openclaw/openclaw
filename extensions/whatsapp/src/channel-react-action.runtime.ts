// Whatsapp plugin module implements channel react action behavior.
import {
  createActionGate,
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  ToolAuthorizationError,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
export { handleWhatsAppAction } from "./action-runtime.js";
export { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
export { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "./accounts.js";
export {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize.js";
export { sendMessageWhatsApp, sendStatusWhatsApp } from "./send.js";
export {
  createActionGate,
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  ToolAuthorizationError,
  type OpenClawConfig,
};
