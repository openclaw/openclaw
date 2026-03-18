export {
  createActionGate,
  DEFAULT_ACCOUNT_ID,
  formatWhatsAppConfigAllowFromEntries,
  buildChannelConfigSchema,
  getChatChannelMeta,
  jsonResult,
  normalizeE164,
  readReactionParams,
  readStringParam,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppOutboundTarget,
  ToolAuthorizationError,
  WhatsAppConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../../../src/plugin-sdk/whatsapp-core.js";

export {
  createWhatsAppOutboundBase,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  type ChannelMessageActionName,
  type DmPolicy,
  type GroupPolicy,
  type WhatsAppAccountConfig,
} from "openclaw/plugin-sdk/whatsapp";

export { monitorWebChannel } from "openclaw/plugin-sdk/whatsapp";
