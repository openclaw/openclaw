export {
  buildChannelConfigSchema,
  createActionGate,
  DEFAULT_ACCOUNT_ID,
  formatWhatsAppConfigAllowFromEntries,
  getChatChannelMeta,
  jsonResult,
  normalizeE164,
  readReactionParams,
  readStringParam,
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
  resolveWhatsAppOutboundTarget,
  ToolAuthorizationError,
  WhatsAppConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../../../src/plugin-sdk/whatsapp-core.js";

export {
  createWhatsAppOutboundBase,
  isWhatsAppGroupJid,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  type ChannelMessageActionName,
  type DmPolicy,
  type GroupPolicy,
  type WhatsAppAccountConfig,
} from "../../../src/plugin-sdk/whatsapp-shared.js";

export { monitorWebChannel } from "./channel.runtime.js";
