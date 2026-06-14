// Slack plugin module implements targets behavior.
export {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
  slackTargetsMatch,
} from "./target-parsing.js";
export type { SlackTarget, SlackTargetKind, SlackTargetParseOptions } from "./target-parsing.js";
