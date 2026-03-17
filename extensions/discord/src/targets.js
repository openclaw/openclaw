import {
  buildMessagingTarget,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind
} from "../../../src/channels/targets.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { listDiscordDirectoryPeersLive } from "./directory-live.js";
function parseDiscordTarget(raw, options = {}) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "discord:", kind: "user" }
    ],
    atUserPattern: /^\d+$/,
    atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)"
  });
  if (userTarget) {
    return userTarget;
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ?? `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveDiscordChannelId(raw) {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Discord", target, kind: "channel" });
}
async function resolveDiscordTarget(raw, options, parseOptions = {}) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  const likelyUsername = isLikelyUsername(trimmed);
  const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
  const directParse = safeParseDiscordTarget(trimmed, parseOptions);
  if (directParse && directParse.kind !== "channel" && !likelyUsername) {
    return directParse;
  }
  if (!shouldLookup) {
    return directParse ?? parseDiscordTarget(trimmed, parseOptions);
  }
  try {
    const directoryEntries = await listDiscordDirectoryPeersLive({
      ...options,
      query: trimmed,
      limit: 1
    });
    const match = directoryEntries[0];
    if (match && match.kind === "user") {
      const userId = match.id.replace(/^user:/, "");
      rememberDiscordDirectoryUser({
        accountId: options.accountId,
        userId,
        handles: [trimmed, match.name, match.handle]
      });
      return buildMessagingTarget("user", userId, trimmed);
    }
  } catch {
  }
  return parseDiscordTarget(trimmed, parseOptions);
}
function safeParseDiscordTarget(input, options) {
  try {
    return parseDiscordTarget(input, options);
  } catch {
    return void 0;
  }
}
function isExplicitUserLookup(input, options) {
  if (/^<@!?(\d+)>$/.test(input)) {
    return true;
  }
  if (/^(user:|discord:)/.test(input)) {
    return true;
  }
  if (input.startsWith("@")) {
    return true;
  }
  if (/^\d+$/.test(input)) {
    return options.defaultKind === "user";
  }
  return false;
}
function isLikelyUsername(input) {
  if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) {
    return false;
  }
  return true;
}
export {
  parseDiscordTarget,
  resolveDiscordChannelId,
  resolveDiscordTarget
};
