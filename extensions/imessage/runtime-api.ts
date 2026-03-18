export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
  resolveChannelMediaMaxBytes,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
  IMessageConfigSchema,
  type ChannelPlugin,
  type IMessageAccountConfig,
} from "openclaw/plugin-sdk/imessage";
// Re-export outbound send-dep helpers so that lazy-loaded channel runtime
// files can import them via a relative path ("./runtime-api.js") rather
// than the bare "openclaw" package specifier, which may not be resolvable
// when the runtime file is loaded outside the bundled context (e.g. in
// a pnpm workspace that installs openclaw as a dependency).
export { resolveOutboundSendDep, type OutboundSendDeps } from "openclaw/plugin-sdk/channel-runtime";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./src/group-policy.js";

export { monitorIMessageProvider } from "./src/monitor.js";
export type { MonitorIMessageOpts } from "./src/monitor.js";
export { probeIMessage } from "./src/probe.js";
export { sendMessageIMessage } from "./src/send.js";
