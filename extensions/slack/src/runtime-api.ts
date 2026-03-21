// SDK primitives from public plugin-sdk subpaths.
export {
  buildComputedAccountStatusSnapshot,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "openclaw/plugin-sdk/status-helpers";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  getChatChannelMeta,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
export { type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-pairing";
export { SlackConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
  withNormalizedTimestamp,
} from "openclaw/plugin-sdk/agent-runtime";

// Slack-specific helpers from extension-internal modules.
export type { SlackAccountConfig } from "openclaw/plugin-sdk/config-runtime";
export { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./targets.js";
export {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "./directory-config.js";
export { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
