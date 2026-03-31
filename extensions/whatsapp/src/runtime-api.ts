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
  ToolAuthorizationError,
  WhatsAppConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/whatsapp-core";

export {
  createWhatsAppOutboundBase,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  resolveWhatsAppHeartbeatRecipients,
  resolveWhatsAppMentionStripRegexes,
  type ChannelMessageActionName,
  type DmPolicy,
  type GroupPolicy,
  type WhatsAppAccountConfig,
} from "openclaw/plugin-sdk/whatsapp-shared";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/whatsapp";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
export { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
type MonitorWebChannel = typeof import("./channel.runtime.js").monitorWebChannel;

let channelRuntimePromise: Promise<typeof import("./channel.runtime.js")> | null = null;

function loadChannelRuntime() {
  channelRuntimePromise ??= import("./channel.runtime.js");
  return channelRuntimePromise;
}

export async function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  const { monitorWebChannel } = await loadChannelRuntime();
  return await monitorWebChannel(...args);
}
