export type { IMessageAccountConfig } from "../../src/config/types.imessage.js";
export type { ChannelPlugin } from "../../src/channels/plugins/types.plugin.js";
export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  buildChannelConfigSchema,
  getChatChannelMeta,
} from "../../src/plugin-sdk/channel-plugin-common.js";
export {
  formatTrimmedAllowFromEntries,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "../../src/plugin-sdk/channel-config-helpers.js";
export { collectStatusIssuesFromLastError } from "../../src/plugin-sdk/status-helpers.js";
export { resolveChannelMediaMaxBytes } from "../../src/channels/plugins/media-limits.js";
export {
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
} from "../../src/channels/plugins/normalize/imessage.js";
export { IMessageConfigSchema } from "../../src/config/zod-schema.providers-core.js";
// Re-export outbound send-dep helpers so that lazy-loaded channel runtime
// files (channel.runtime.ts) can import them via a relative path rather than
// the bare "openclaw" package specifier, which may not be resolvable when the
// file is loaded outside the bundled context (e.g. in a pnpm workspace).
export {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "../../src/infra/outbound/send-deps.js";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./src/group-policy.js";
export { monitorIMessageProvider } from "./src/monitor.js";
export type { MonitorIMessageOpts } from "./src/monitor.js";
export { probeIMessage } from "./src/probe.js";
export { sendMessageIMessage } from "./src/send.js";
