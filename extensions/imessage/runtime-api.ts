import type { MullusiConfig as RuntimeApiMullusiConfig } from "mullusi/plugin-sdk/core";

export {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
  type MullusiConfig,
} from "mullusi/plugin-sdk/core";
export { buildChannelConfigSchema, IMessageConfigSchema } from "./config-api.js";
export { PAIRING_APPROVED_MESSAGE } from "mullusi/plugin-sdk/channel-status";
export {
  buildComputedAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "mullusi/plugin-sdk/status-helpers";
export { formatTrimmedAllowFromEntries } from "mullusi/plugin-sdk/channel-config-helpers";
export {
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./src/config-accessors.js";
export { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./src/normalize.js";
export { resolveChannelMediaMaxBytes } from "mullusi/plugin-sdk/media-runtime";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./src/group-policy.js";

export { monitorIMessageProvider } from "./src/monitor.js";
export type { MonitorIMessageOpts } from "./src/monitor.js";
export { probeIMessage } from "./src/probe.js";
export type { IMessageProbe } from "./src/probe.js";
export { sendMessageIMessage } from "./src/send.js";
export { chunkTextForOutbound } from "./src/channel-api.js";

export type IMessageAccountConfig = Omit<
  NonNullable<NonNullable<RuntimeApiMullusiConfig["channels"]>["imessage"]>,
  "accounts" | "defaultAccount"
>;
