export { getChatChannelMeta, type ChannelPlugin } from "openclaw/plugin-sdk/core";
export { buildChannelConfigSchema, WhatsAppConfigSchema } from "../config-api.js";
export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "./config-accessors.js";
export {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
  ToolAuthorizationError,
} from "openclaw/plugin-sdk/channel-actions";
export { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
export type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig as RuntimeOpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

// This is the authoritative heavy runtime assembly for WhatsApp. Keep the
// host-facing runtime wrappers as thin delegates to this module.
export { getActiveWebListener } from "./active-listener.js";
export * from "./action-runtime.js";
export { createWhatsAppLoginTool } from "./agent-tools-login.js";
export {
  getWebAuthAgeMs,
  logWebSelfId,
  logoutWeb,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./auth-store.js";
export { type ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
export { loadOutboundMediaFromUrl } from "./outbound-media.runtime.js";
export {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
export {
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "./group-intro.js";
export { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
export { createWhatsAppOutboundBase } from "./outbound-base.js";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
export { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
export { resolveWhatsAppReactionLevel } from "./reaction-level.js";
export * from "./inbound.js";
export { loginWeb } from "./login.js";
export { startWebLoginWithQr, waitForWebLogin } from "../login-qr-runtime.js";
export * from "./media.js";
export * from "./send.js";
export { formatError, getStatusCode } from "./session-errors.js";
export * from "./session.js";
export { setWhatsAppRuntime } from "./runtime.js";

export type OpenClawConfig = RuntimeOpenClawConfig;
export type { WhatsAppAccountConfig } from "./account-types.js";
