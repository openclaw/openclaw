import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind
} from "../../../src/channels/targets.js";
function parseSlackTarget(raw, options = {}) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" }
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)"
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)"
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveSlackChannelId(raw) {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Slack", target, kind: "channel" });
}
export {
  parseSlackTarget,
  resolveSlackChannelId
};
